import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import mongoose from "mongoose";
import axios from "axios";
import { createClient } from "redis";
import rateLimit from "express-rate-limit";
import { Client } from "@elastic/elasticsearch";
import multer from "multer";
import { randomUUID } from "crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { detectImageType } from "./imageType.js";
import { validateImageReference } from "./imageReference.js";
import crypto from "crypto";

dotenv.config();

// /sync-user is authenticated with a shared secret rather than a user token,
// so an unset value would silently disable that check. Refuse to start instead,
// matching how auth-service treats JWT_SECRET.
if (!process.env.INTERNAL_SERVICE_TOKEN) {
  console.error("❌ User Service - INTERNAL_SERVICE_TOKEN is not set. Refusing to start.");
  process.exit(1);
}

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_FILE_SIZE = 5 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, GIF and WebP are allowed.'));
    }
  },
});

// Supabase Storage client — optional; uploads return 503 if not configured
let supabase = null;
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'uploads';
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createSupabaseClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
} else {
  console.log('⚠️ User Service - Supabase credentials not set; image uploads will be unavailable');
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(cors());

// Elasticsearch client
let esClient = null;
const connectElasticsearch = async () => {
  try {
    esClient = new Client({
      node: process.env.ELASTICSEARCH_URL || 'http://localhost:9200'
    });
    
    // Test connection
    await esClient.ping();
    console.log("✅ User Service - Elasticsearch Connected");
    
    // Create index if it doesn't exist
    const indexExists = await esClient.indices.exists({ index: 'users' });
    if (!indexExists) {
      await esClient.indices.create({
        index: 'users',
        body: {
          mappings: {
            properties: {
              firstName: { 
                type: 'text',
                fields: {
                  keyword: { type: 'keyword' }
                }
              },
              lastName: { 
                type: 'text',
                fields: {
                  keyword: { type: 'keyword' }
                }
              },
              email: { 
                type: 'text',
                fields: {
                  keyword: { type: 'keyword' }
                }
              },
              bio: { type: 'text' },
              fullName: { 
                type: 'text',
                fields: {
                  keyword: { type: 'keyword' }
                }
              }
            }
          }
        }
      });
      console.log("✅ Created Elasticsearch index: users");
    }
  } catch (error) {
    console.log("⚠️ User Service - Elasticsearch connection failed:", error.message);
  }
};

// Rate limiting
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { message: 'Too many search requests, please slow down.' }
});

// Uploads consume third-party storage, so they are capped independently
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { message: 'Too many image uploads, please try again later.' }
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

// Redis client
let redisClient = null;
const connectRedis = async () => {
  try {
    redisClient = createClient({ url: process.env.REDIS_URL });
    await redisClient.connect();
    console.log("✅ User Service - Redis Connected");
  } catch (error) {
    console.log("⚠️ User Service - Redis connection failed:", error.message);
  }
};

// MongoDB connection
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/user-service');
    console.log("✅ User Service - MongoDB Connected");
  } catch (error) {
    console.error("❌ User Service - MongoDB Connection Error:", error);
    process.exit(1);
  }
};

connectDB();
connectRedis();
connectElasticsearch();

// Auth middleware
// Service-to-service guard for endpoints that no end user ever calls.
// /sync-user runs during registration, before the new user has a token, so it
// cannot use `protect`. It is reachable through the gateway, so without this it
// would accept an attacker-controlled profile -- including _id, email and a
// pre-hashed password. Compared in constant time to avoid leaking the secret
// through response timing.
const requireInternalAuth = (req, res, next) => {
  const presented = req.headers["x-internal-token"];
  const expected = process.env.INTERNAL_SERVICE_TOKEN;
  if (typeof expected !== "string" || expected.length === 0) {
    // Startup already refuses this state; reject rather than throw if it ever
    // occurs anyway, so the failure mode stays 401 and never 500-with-stack.
    return res.status(401).json({ message: "Unauthorized" });
  }
  if (typeof presented !== "string" || presented.length !== expected.length) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (!crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
};

const protect = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) {
      return res.status(401).json({ message: "No token provided" });
    }

    // Verify token with auth service
    const response = await axios.post(`${process.env.AUTH_SERVICE_URL}/verify`, { token });
    req.user = response.data.user;
    next();
  } catch (error) {
    res.status(401).json({ message: "Unauthorized" });
  }
};

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "healthy", service: "user-service" });
});

// Upload profile picture — stores in Supabase Storage and returns the public URL
app.post("/upload", protect, uploadLimiter, upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "No image file provided" });
  }
  if (!supabase) {
    return res.status(503).json({ message: "Image storage is not configured" });
  }

  // Trust the file's own bytes, not the client-supplied filename or Content-Type
  const detected = detectImageType(req.file.buffer);
  if (!detected) {
    return res.status(400).json({
      message: "File content is not a valid JPEG, PNG, GIF or WebP image"
    });
  }

  const objectPath = `profiles/${req.user._id}/${randomUUID()}${detected.ext}`;

  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(objectPath, req.file.buffer, {
      contentType: detected.mime,
      upsert: false,
    });

  if (error) {
    console.error('Supabase upload error:', error.message);
    return res.status(500).json({ message: "Upload failed" });
  }

  const { data: { publicUrl } } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(objectPath);
  res.status(201).json({ imageUrl: publicUrl });
});

// Multer error handler
app.use('/upload', (err, _req, res, _next) => {
  if (err instanceof multer.MulterError || err.message?.includes('Invalid file type')) {
    return res.status(400).json({ message: err.message });
  }
  res.status(500).json({ message: "Upload failed" });
});

// Sync user from auth-service
app.post("/sync-user", requireInternalAuth, async (req, res) => {
  try {
    const { _id, firstName, lastName, email, password, createdAt } = req.body;
    
    // Check if user already exists
    const existingUser = await User.findById(_id);
    if (existingUser) {
      return res.json({ message: "User already exists" });
    }

    // Create user with the same ID from auth-service
    const user = await User.create({
      _id,
      firstName,
      lastName,
      email,
      password,
      createdAt
    });

    // Index user in Elasticsearch
    if (esClient) {
      try {
        await esClient.index({
          index: 'users',
          id: _id.toString(),
          document: {
            firstName,
            lastName,
            email,
            fullName: `${firstName} ${lastName}`
          }
        });
      } catch (esError) {
        console.error("Elasticsearch indexing error:", esError.message);
      }
    }

    res.status(201).json({ message: "User synced successfully" });
  } catch (error) {
    console.error("User sync error:", error);
    res.status(500).json({ message: "Sync failed", error: error.message });
  }
});

// Get current user profile
app.get("/me", protect, async (req, res) => {
  try {
    // Check cache
    if (redisClient?.isOpen) {
      const cached = await redisClient.get(`user:${req.user._id}`);
      if (cached) return res.json(JSON.parse(cached));
    }

    const user = await User.findById(req.user._id).select("-password");
    
    // Cache result
    if (redisClient?.isOpen) {
      await redisClient.setEx(`user:${req.user._id}`, 600, JSON.stringify(user));
    }
    
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

// Search users
app.get("/search", protect, searchLimiter, async (req, res) => {
  try {
    const { q } = req.query;
    
    console.log(`🔍 Search request received: query="${q}"`);
    
    if (!q || q.trim() === "") {
      return res.json([]);
    }

    // Try Elasticsearch first
    if (esClient) {
      try {
        console.log("🔍 Using Elasticsearch for search");
        const result = await esClient.search({
          index: 'users',
          body: {
            query: {
              bool: {
                should: [
                  // Exact prefix matching (highest boost)
                  {
                    multi_match: {
                      query: q,
                      fields: ['firstName^5', 'lastName^5', 'fullName^6'],
                      type: 'phrase_prefix'
                    }
                  },
                  // Fuzzy matching for typos
                  {
                    multi_match: {
                      query: q,
                      fields: ['firstName^3', 'lastName^3', 'fullName^4', 'email^2'],
                      fuzziness: 'AUTO'
                    }
                  },
                  // Wildcard matching on keywords (case insensitive)
                  {
                    query_string: {
                      query: `*${q}*`,
                      fields: ['firstName.keyword', 'lastName.keyword', 'email.keyword'],
                      default_operator: 'OR',
                      analyze_wildcard: false
                    }
                  }
                ],
                minimum_should_match: 1
              }
            },
            size: 10
          }
        });

        console.log(`✅ Elasticsearch returned ${result.hits.hits.length} results`);
        const userIds = result.hits.hits.map(hit => hit._id);
        
        if (userIds.length === 0) {
          console.log("⚠️ No results from Elasticsearch, falling back to MongoDB");
          // Fall through to MongoDB search
        } else {
          const users = await User.find({ _id: { $in: userIds } }).select("-password");
          
          // Sort by Elasticsearch relevance score
          const sortedUsers = userIds.map(id => users.find(u => u._id.toString() === id)).filter(Boolean);
          
          console.log(`✅ Returning ${sortedUsers.length} users from Elasticsearch search`);
          return res.json(sortedUsers);
        }
      } catch (esError) {
        console.error("❌ Elasticsearch search error:", esError.message);
        console.log("⚠️ Falling back to MongoDB search");
        // Fall through to MongoDB search
      }
    } else {
      console.log("⚠️ Elasticsearch client not available, using MongoDB");
    }

    // Fallback to MongoDB search
    const users = await User.find({
      $or: [
        { firstName: { $regex: q, $options: "i" } },
        { lastName: { $regex: q, $options: "i" } },
        { email: { $regex: q, $options: "i" } }
      ]
    })
    .select("-password")
    .limit(10);

    console.log(`✅ MongoDB search returned ${users.length} results`);
    res.json(users);
  } catch (error) {
    console.error("❌ Search error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

// Update user profile
app.put("/me", protect, async (req, res) => {
  try {
    const { firstName, lastName, bio, profilePic } = req.body;

    // profilePic is the avatar equivalent of post.image: only a URL that
    // /upload produced is acceptable.
    let validatedProfilePic;
    try {
      validatedProfilePic = validateImageReference(profilePic);
    } catch (imageError) {
      return res.status(400).json({ message: imageError.message });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (firstName) user.firstName = firstName;
    if (lastName) user.lastName = lastName;
    if (bio !== undefined) user.bio = bio;
    if (profilePic !== undefined) user.profilePic = validatedProfilePic;

    await user.save();

    // Clear user cache
    if (redisClient?.isOpen) {
      try {
        // Clear own user cache
        await redisClient.del(`user:${req.user._id}`);
        
        // Clear the global feed cache (user name/avatar appear in cached post data)
        await redisClient.del('posts:feed:global');
        console.log('🗑️ Cleared global post feed cache');
      } catch (cacheError) {
        console.error("Cache clear error:", cacheError.message);
      }
    }

    // Update Elasticsearch index
    if (esClient) {
      try {
        await esClient.update({
          index: 'users',
          id: user._id.toString(),
          doc: {
            firstName: user.firstName,
            lastName: user.lastName,
            fullName: `${user.firstName} ${user.lastName}`,
            bio: user.bio || ''
          }
        });
      } catch (esError) {
        console.error("Elasticsearch update error:", esError.message);
      }
    }

    const updatedUser = await User.findById(user._id).select("-password");
    res.json(updatedUser);
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

// Get current user's posts (must come before /:userId route)
app.get("/me/posts", protect, async (req, res) => {
  try {
    const response = await axios.get(`${process.env.POST_SERVICE_URL}/user/${req.user._id}`, {
      headers: { authorization: req.headers.authorization }
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

// Get user by ID (for post service)
app.get("/:userId", protect, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select("-password");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

// Get user's posts by ID
app.get("/:userId/posts", protect, async (req, res) => {
  try {
    const response = await axios.get(`${process.env.POST_SERVICE_URL}/user/${req.params.userId}`, {
      headers: { authorization: req.headers.authorization }
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`👤 User Service running on port ${PORT}`));
