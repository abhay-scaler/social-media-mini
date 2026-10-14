import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import mongoose from "mongoose";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import axios from "axios";
import { createClient } from "redis";
import { createHash } from "crypto";

dotenv.config();

// Every token this service issues and validates depends on JWT_SECRET. An unset
// value would otherwise surface as a 500 on every login instead of at startup.
if (!process.env.JWT_SECRET) {
  console.error("❌ Auth Service - JWT_SECRET is not set. Refusing to start.");
  process.exit(1);
}

// Registration syncs the new profile to user-service over an internal,
// token-authenticated endpoint. Without the secret every registration would
// roll back with a 503, so fail at startup rather than at first use.
if (!process.env.INTERNAL_SERVICE_TOKEN) {
  console.error("❌ Auth Service - INTERNAL_SERVICE_TOKEN is not set. Refusing to start.");
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(cors());

// Rate limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: { message: 'Too many authentication attempts, please try again later.' }
});

// User Schema
const userSchema = new mongoose.Schema({
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  bio: { type: String, default: "" },
  profilePic: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model("User", userSchema);

// Connect to MongoDB
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/auth-service');
    console.log("✅ Auth Service - MongoDB Connected");
  } catch (error) {
    console.error("❌ Auth Service - MongoDB Connection Error:", error);
    process.exit(1);
  }
};

connectDB();

// Redis client — optional; auth continues without it if Redis is unavailable
let redisClient = null;
const connectRedis = async () => {
  if (!process.env.REDIS_URL) return;
  try {
    redisClient = createClient({ url: process.env.REDIS_URL });
    redisClient.on('error', (err) => {
      console.log('⚠️ Auth Service - Redis error:', err.message);
    });
    await redisClient.connect();
    console.log("✅ Auth Service - Redis Connected");
  } catch (error) {
    console.log("⚠️ Auth Service - Redis connection failed, running without cache:", error.message);
    redisClient = null;
  }
};

if (process.env.NODE_ENV !== 'test') {
  connectRedis();
}

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "healthy", service: "auth-service" });
});

// REGISTER
app.post("/register", authLimiter, async (req, res) => {
  try {
    const { firstName, lastName, email, password } = req.body;

    if (!firstName || !lastName || !email || !password) {
      return res.status(400).json({ message: "All fields are required" });
    }

    const userExists = await User.findOne({ email });
    if (userExists) {
      return res.status(400).json({ message: "User already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
      firstName,
      lastName,
      email,
      password: hashedPassword,
    });

    // Sync user to user-service with bounded retry.
    // On total failure: delete the auth user to prevent an orphaned credential record
    // and return 503 so the client knows registration did not complete.
    const syncPayload = {
      _id: user._id.toString(),
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      password: hashedPassword,
      createdAt: user.createdAt
    };
    const USER_SERVICE_URL = process.env.USER_SERVICE_URL || 'http://user-service:3002';
    const MAX_SYNC_RETRIES = 3;
    let syncSucceeded = false;
    for (let attempt = 1; attempt <= MAX_SYNC_RETRIES; attempt++) {
      try {
        await axios.post(`${USER_SERVICE_URL}/sync-user`, syncPayload, {
          headers: { "x-internal-token": process.env.INTERNAL_SERVICE_TOKEN },
        });
        syncSucceeded = true;
        break;
      } catch (syncError) {
        console.error(`Sync attempt ${attempt}/${MAX_SYNC_RETRIES} failed:`, syncError.message);
        if (attempt < MAX_SYNC_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
        }
      }
    }
    if (!syncSucceeded) {
      // Roll back: delete the auth user so the email is not permanently claimed.
      // If the rollback itself fails, the credential record is orphaned with no
      // profile, so log the id an operator needs to clean it up by hand.
      try {
        await User.findByIdAndDelete(user._id);
      } catch (rollbackError) {
        console.error(
          `ROLLBACK FAILED for auth user ${user._id} after user-service sync failure. ` +
          `Orphaned credential record requires manual cleanup: ${rollbackError.message}`
        );
      }
      return res.status(503).json({
        message: "Registration failed: user profile service unavailable. Please try again."
      });
    }

    return res.status(201).json({ message: "User registered successfully", userId: user._id });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// LOGIN
app.post("/login", authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    return res.json({
      token,
      user: { 
        id: user._id, 
        firstName: user.firstName, 
        lastName: user.lastName, 
        email: user.email 
      },
    });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// VERIFY TOKEN (for other services)
// Cache verification results in Redis so all auth-service instances share state.
// Falls back to direct DB lookup if Redis is unavailable — never fails open.
const VERIFY_CACHE_TTL_S = 5;

// Key on a digest rather than the bearer token itself, so a dump of Redis keys
// does not hand out usable credentials.
const cacheKeyFor = (token) => `verify:${createHash('sha256').update(token).digest('hex')}`;

const getCachedVerify = async (token) => {
  if (!redisClient?.isOpen) return null;
  try {
    const raw = await redisClient.get(cacheKeyFor(token));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const setCachedVerify = async (token, user) => {
  if (!redisClient?.isOpen) return;
  try {
    await redisClient.setEx(cacheKeyFor(token), VERIFY_CACHE_TTL_S, JSON.stringify(user));
  } catch {
    // Cache write failure is non-fatal
  }
};

app.post("/verify", async (req, res) => {
  try {
    const token = req.body?.token;

    if (!token) {
      return res.status(401).json({ message: "No token provided" });
    }

    const cachedUser = await getCachedVerify(token);
    if (cachedUser) {
      return res.json({ user: cachedUser });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select("-password");

    if (!user) {
      return res.status(401).json({ message: "Invalid token" });
    }

    await setCachedVerify(token, user);
    res.json({ user });
  } catch (err) {
    res.status(401).json({ message: "Invalid token", error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🔐 Auth Service running on port ${PORT}`));
