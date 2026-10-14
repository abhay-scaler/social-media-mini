import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import mongoose from "mongoose";
import axios from "axios";
import { createClient } from "redis";
import rateLimit from "express-rate-limit";
import { Server } from "socket.io";
import { createServer } from "http";
import multer from "multer";
import { randomUUID } from "crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { detectImageType } from "./imageType.js";

dotenv.config();

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
  console.log('⚠️ Post Service - Supabase credentials not set; image uploads will be unavailable');
}

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"]
  }
});

app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(cors());

// Rate limiters
const postLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { message: 'Too many posts created, please try again later.' }
});

const commentLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 50,
  message: { message: 'Too many comments posted, please try again later.' }
});

const likeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 100,
  message: { message: 'Too many like actions, please try again later.' }
});

// Uploads consume third-party storage, so they are capped independently of posts
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  message: { message: 'Too many image uploads, please try again later.' }
});

// Post Schema
const commentSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, required: true },
  text: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  replies: [{
    user: { type: mongoose.Schema.Types.ObjectId, required: true },
    text: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
  }]
});

const postSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, required: true, ref: "User" },
  text: { type: String, required: true },
  image: { type: String },
  youtubeUrl: { type: String },
  likes: [{ type: mongoose.Schema.Types.ObjectId }],
  comments: [commentSchema],
  createdAt: { type: Date, default: Date.now }
});

const Post = mongoose.model("Post", postSchema);

// Helper function to extract YouTube video ID
const extractYouTubeId = (url) => {
  if (!url) return null;
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/v\/([a-zA-Z0-9_-]{11})/
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
};

// Redis client
let redisClient = null;
const connectRedis = async () => {
  try {
    redisClient = createClient({ url: process.env.REDIS_URL });
    await redisClient.connect();
    console.log("✅ Post Service - Redis Connected");
  } catch (error) {
    console.log("⚠️ Post Service - Redis connection failed:", error.message);
  }
};

// MongoDB connection
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/post-service');
    console.log("✅ Post Service - MongoDB Connected");
  } catch (error) {
    console.error("❌ Post Service - MongoDB Connection Error:", error);
    process.exit(1);
  }
};

// Only connect to DB and Redis if not in test mode
if (process.env.NODE_ENV !== 'test') {
  connectDB();
  connectRedis();
}

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Auth middleware
const protect = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) {
      return res.status(401).json({ message: "No token provided" });
    }

    const response = await axios.post(`${process.env.AUTH_SERVICE_URL}/verify`, { token });
    req.user = response.data.user;
    next();
  } catch (error) {
    res.status(401).json({ message: "Unauthorized" });
  }
};

// The feed is global, so there is exactly one key to drop. Deleting it directly
// avoids a KEYS scan, which blocks Redis's single thread, on every mutation.
const FEED_CACHE_KEY = 'posts:feed:global';

const clearFeedCache = async () => {
  if (redisClient?.isOpen) {
    try {
      await redisClient.del(FEED_CACHE_KEY);
    } catch (err) {
      console.log('Cache clear error:', err.message);
    }
  }
};

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "healthy", service: "post-service" });
});

// Upload image — stores in Supabase Storage and returns the public URL
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

  const objectPath = `posts/${req.user._id}/${randomUUID()}${detected.ext}`;

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

// Multer error handler (file type / size violations)
app.use('/upload', (err, _req, res, _next) => {
  if (err instanceof multer.MulterError || err.message?.includes('Invalid file type')) {
    return res.status(400).json({ message: err.message });
  }
  res.status(500).json({ message: "Upload failed" });
});

// Create post
app.post("/", protect, postLimiter, async (req, res) => {
  try {
    const { text, image, youtubeUrl } = req.body;

    // Reject an image reference the upload path did not produce.
    let validatedImage;
    try {
      validatedImage = validateImageReference(image);
    } catch (imageError) {
      return res.status(400).json({ message: imageError.message });
    }

    // Validate YouTube URL if provided
    let validatedYoutubeUrl = null;
    if (youtubeUrl && youtubeUrl.trim()) {
      const videoId = extractYouTubeId(youtubeUrl);
      if (videoId) {
        validatedYoutubeUrl = `https://www.youtube.com/embed/${videoId}`;
      }
    }

    const post = await Post.create({
      user: req.user._id,
      text,
      image: validatedImage,
      youtubeUrl: validatedYoutubeUrl,
    });

    await clearFeedCache();
    
    // Populate user data for socket emission
    const postWithUser = post.toObject();
    try {
      const userResponse = await axios.get(`${process.env.USER_SERVICE_URL}/${req.user._id}`, {
        headers: { authorization: req.headers.authorization },
      });
      postWithUser.user = userResponse.data;
    } catch {
      postWithUser.user = { _id: req.user._id };
    }
    
    // Emit socket event for new post with populated user
    io.emit('post:created', postWithUser);
    
    res.status(201).json(post);
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

// Get all posts (Feed)
app.get("/", protect, async (req, res) => {
  try {
    // Check cache — feed is global (not personalized), so one shared key
    const cacheKey = FEED_CACHE_KEY;
    if (redisClient?.isOpen) {
      const cached = await redisClient.get(cacheKey);
      if (cached) return res.json(JSON.parse(cached));
    }

    const posts = await Post.find().sort({ createdAt: -1 });

    // Fetch user details for each post and comment
    const postsWithUsers = await Promise.all(posts.map(async (post) => {
      try {
        const postObj = post.toObject();
        
        // Fetch post author
        const userResponse = await axios.get(`${process.env.USER_SERVICE_URL}/${post.user}`, {
        headers: { authorization: req.headers.authorization },
      });
        postObj.user = userResponse.data;
        
        // Fetch comment authors
        if (postObj.comments && postObj.comments.length > 0) {
          postObj.comments = await Promise.all(postObj.comments.map(async (comment) => {
            try {
              const commentUserResponse = await axios.get(`${process.env.USER_SERVICE_URL}/${comment.user}`, {
        headers: { authorization: req.headers.authorization },
      });
              return { ...comment, user: commentUserResponse.data };
            } catch {
              return comment;
            }
          }));
        }
        
        return postObj;
      } catch {
        return { ...post.toObject(), user: null };
      }
    }));

    // Cache result
    if (redisClient?.isOpen) {
      await redisClient.setEx(cacheKey, 300, JSON.stringify(postsWithUsers));
    }

    res.json(postsWithUsers);
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

// Delete post
app.delete("/:postId", protect, async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId);
    
    if (!post) {
      return res.status(404).json({ message: "Post not found" });
    }

    // Check if user owns the post
    if (post.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Not authorized to delete this post" });
    }

    await Post.findByIdAndDelete(req.params.postId);
    await clearFeedCache();

    // Emit Socket.io event
    io.emit('post:deleted', { postId: req.params.postId });

    res.json({ message: "Post deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

// Update post
app.put("/:postId", protect, async (req, res) => {
  try {
    const { text, image, youtubeUrl } = req.body;

    // Reject an image reference the upload path did not produce.
    let validatedImage;
    try {
      validatedImage = validateImageReference(image);
    } catch (imageError) {
      return res.status(400).json({ message: imageError.message });
    }
    const post = await Post.findById(req.params.postId);
    
    if (!post) {
      return res.status(404).json({ message: "Post not found" });
    }

    // Check if user owns the post
    if (post.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Not authorized to update this post" });
    }

    // Validate YouTube URL if provided
    let validatedYoutubeUrl = null;
    if (youtubeUrl && youtubeUrl.trim()) {
      const videoId = extractYouTubeId(youtubeUrl);
      if (videoId) {
        validatedYoutubeUrl = `https://www.youtube.com/embed/${videoId}`;
      }
    }

    // Update fields
    if (text !== undefined) post.text = text;
    if (image !== undefined) post.image = validatedImage;
    if (youtubeUrl !== undefined) post.youtubeUrl = validatedYoutubeUrl;

    await post.save();
    await clearFeedCache();

    // Populate user info for post, comments, and replies
    const updatedPost = post.toObject();
    try {
      const userResponse = await axios.get(`${process.env.USER_SERVICE_URL}/${post.user}`, {
        headers: { authorization: req.headers.authorization },
      });
      updatedPost.user = userResponse.data;
    } catch {
      updatedPost.user = { _id: post.user };
    }

    // Populate user info for comments and replies
    if (updatedPost.comments && updatedPost.comments.length > 0) {
      for (const comment of updatedPost.comments) {
        try {
          const commentUserResponse = await axios.get(`${process.env.USER_SERVICE_URL}/${comment.user}`, {
        headers: { authorization: req.headers.authorization },
      });
          comment.user = commentUserResponse.data;
        } catch {
          comment.user = { _id: comment.user };
        }

        // Populate reply users
        if (comment.replies && comment.replies.length > 0) {
          for (const reply of comment.replies) {
            try {
              const replyUserResponse = await axios.get(`${process.env.USER_SERVICE_URL}/${reply.user}`, {
        headers: { authorization: req.headers.authorization },
      });
              reply.user = replyUserResponse.data;
            } catch {
              reply.user = { _id: reply.user };
            }
          }
        }
      }
    }

    // Emit Socket.io event
    io.emit('post:updated', updatedPost);

    res.json(updatedPost);
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

// Get user posts
app.get("/user/:userId", protect, async (req, res) => {
  try {
    const posts = await Post.find({ user: req.params.userId }).sort({ createdAt: -1 });
    
    // Populate post user and comment users
    const postsWithUsers = await Promise.all(posts.map(async (post) => {
      const postObj = post.toObject();
      
      // Populate post user
      try {
        const postUserResponse = await axios.get(`${process.env.USER_SERVICE_URL}/${postObj.user}`, {
        headers: { authorization: req.headers.authorization },
      });
        postObj.user = postUserResponse.data;
      } catch {
        postObj.user = { _id: postObj.user };
      }
      
      // Populate comment users
      if (postObj.comments && postObj.comments.length > 0) {
        postObj.comments = await Promise.all(postObj.comments.map(async (comment) => {
          try {
            const commentUserResponse = await axios.get(`${process.env.USER_SERVICE_URL}/${comment.user}`, {
        headers: { authorization: req.headers.authorization },
      });
            const commentWithUser = { ...comment, user: commentUserResponse.data };
            
            // Populate reply users
            if (comment.replies && comment.replies.length > 0) {
              commentWithUser.replies = await Promise.all(comment.replies.map(async (reply) => {
                try {
                  const replyUserResponse = await axios.get(`${process.env.USER_SERVICE_URL}/${reply.user}`, {
        headers: { authorization: req.headers.authorization },
      });
                  return { ...reply, user: replyUserResponse.data };
                } catch {
                  return reply;
                }
              }));
            }
            
            return commentWithUser;
          } catch {
            return comment;
          }
        }));
      }
      
      return postObj;
    }));
    
    res.json(postsWithUsers);
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

// Add comment
app.post("/:postId/comments", protect, commentLimiter, async (req, res) => {
  try {
    const { text } = req.body;
    const post = await Post.findById(req.params.postId);
    
    if (!post) return res.status(404).json({ message: "Post not found" });

    post.comments.push({ user: req.user._id, text });
    await post.save();
    await clearFeedCache();

    const newComment = post.comments[post.comments.length - 1].toObject();
    
    // Populate user info for the new comment
    try {
      const userResponse = await axios.get(`${process.env.USER_SERVICE_URL}/${req.user._id}`, {
        headers: { authorization: req.headers.authorization },
      });
      newComment.user = userResponse.data;
    } catch {
      newComment.user = { _id: req.user._id };
    }

    // Emit socket event for new comment
    io.emit('comment:added', { postId: post._id, comment: newComment });

    res.status(201).json(newComment);
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

// Add reply to comment
app.post("/:postId/comments/:commentId/replies", protect, commentLimiter, async (req, res) => {
  try {
    const { text } = req.body;
    const post = await Post.findById(req.params.postId);
    
    if (!post) return res.status(404).json({ message: "Post not found" });

    const comment = post.comments.id(req.params.commentId);
    if (!comment) return res.status(404).json({ message: "Comment not found" });

    comment.replies.push({ user: req.user._id, text });
    await post.save();
    await clearFeedCache();

    const newReply = comment.replies[comment.replies.length - 1].toObject();
    
    // Populate user info for the new reply
    try {
      const userResponse = await axios.get(`${process.env.USER_SERVICE_URL}/${req.user._id}`, {
        headers: { authorization: req.headers.authorization },
      });
      newReply.user = userResponse.data;
    } catch {
      newReply.user = { _id: req.user._id };
    }

    // Emit socket event for new reply
    io.emit('reply:added', { postId: post._id, commentId: req.params.commentId, reply: newReply });

    res.status(201).json(newReply);
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

// Delete comment
app.delete("/:postId/comments/:commentId", protect, async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId);
    if (!post) return res.status(404).json({ message: "Post not found" });

    const comment = post.comments.id(req.params.commentId);
    if (!comment) return res.status(404).json({ message: "Comment not found" });

    // Check if user owns the comment
    if (comment.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Not authorized to delete this comment" });
    }

    comment.deleteOne();
    await post.save();
    await clearFeedCache();

    // Emit Socket.io event
    io.emit('comment:deleted', { postId: req.params.postId, commentId: req.params.commentId });

    res.json({ message: "Comment deleted" });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

// Delete reply
app.delete("/:postId/comments/:commentId/replies/:replyId", protect, async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId);
    if (!post) return res.status(404).json({ message: "Post not found" });

    const comment = post.comments.id(req.params.commentId);
    if (!comment) return res.status(404).json({ message: "Comment not found" });

    const reply = comment.replies.id(req.params.replyId);
    if (!reply) return res.status(404).json({ message: "Reply not found" });

    // Check if user owns the reply
    if (reply.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Not authorized to delete this reply" });
    }

    reply.deleteOne();
    await post.save();
    await clearFeedCache();

    // Emit Socket.io event
    io.emit('reply:deleted', { postId: req.params.postId, commentId: req.params.commentId, replyId: req.params.replyId });

    res.json({ message: "Reply deleted" });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

// Like post
app.put("/:postId/like", protect, likeLimiter, async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId);
    if (!post) return res.status(404).json({ message: "Post not found" });

    if (post.likes.includes(req.user._id)) {
      return res.status(400).json({ message: "Post already liked" });
    }

    post.likes.push(req.user._id);
    await post.save();
    await clearFeedCache();

    // Emit socket event for like
    io.emit('post:liked', { postId: post._id, likes: post.likes });

    res.json({ message: "Post liked", likes: post.likes.length });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

// Unlike post
app.put("/:postId/unlike", protect, likeLimiter, async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId);
    if (!post) return res.status(404).json({ message: "Post not found" });

    post.likes = post.likes.filter(id => id.toString() !== req.user._id.toString());
    await post.save();
    await clearFeedCache();

    // Emit socket event for unlike
    io.emit('post:unliked', { postId: post._id, likes: post.likes });

    res.json({ message: "Post unliked", likes: post.likes.length });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

const PORT = process.env.PORT || 3003;

// Only start server if not in test mode
if (process.env.NODE_ENV !== 'test') {
  httpServer.listen(PORT, () => console.log(`📝 Post Service running on port ${PORT}`));
}

export default app;
