/**
 * ŞehzadeMC Backend System - Comprehensive Server Configuration
 * ------------------------------------------------------------
 * This server provides a secure, robust foundation for Minecraft server management,
 * featuring user session persistence, rate limiting, and backend-validated transactions.
 */

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const helmet = require('helmet');
const mongoSanitize = require('express-mongo-sanitize');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/sehzademc';
const SALT_ROUNDS = 12;

// --- Security Middlewares ---
app.use(helmet());
app.use(mongoSanitize());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate Limiter to prevent Brute-Force and DDoS attacks
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: "Too many requests from this IP, please try again later."
});
app.use(globalLimiter);

// --- MongoDB & Persistent Session Configuration ---
mongoose.connect(MONGO_URI)
    .then(() => console.log('Successfully connected to MongoDB.'))
    .catch(err => console.error('Database connection error:', err));

app.use(session({
    secret: process.env.SESSION_SECRET || 'secure_sehzade_secret_key',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ 
        mongoUrl: MONGO_URI,
        collectionName: 'user_sessions',
        ttl: 14 * 24 * 60 * 60 
    }),
    cookie: { 
        httpOnly: true, 
        secure: process.env.NODE_ENV === 'production',
        maxAge: 14 * 24 * 60 * 60 * 1000 
    }
}));

// --- Data Models ---
const User = mongoose.model('User', new mongoose.Schema({
    username: { type: String, required: true, unique: true, lowercase: true },
    password: { type: String, required: true },
    credits: { type: Number, default: 350 },
    role: { type: String, default: 'player' }
}));

const Order = mongoose.model('Order', new mongoose.Schema({
    username: { type: String, required: true },
    item: { type: String, required: true },
    timeSlot: { type: String, required: true },
    status: { type: String, default: 'pending' },
    createdAt: { type: Date, default: Date.now }
}));

// --- Auth Routes ---
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
        const newUser = await User.create({ username, password: hashedPassword });
        
        req.session.userId = newUser._id;
        res.status(201).json({ message: "Registration successful. 350 credits have been credited to your account." });
    } catch (e) {
        res.status(400).json({ error: "Username already exists or invalid data provided." });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username: username.toLowerCase() });
        
        if (user && await bcrypt.compare(password, user.password)) {
            req.session.userId = user._id;
            res.json({ message: "Login successful." });
        } else {
            res.status(401).json({ error: "Invalid credentials." });
        }
    } catch (e) {
        res.status(500).json({ error: "Internal server error." });
    }
});

// --- Shop & Transaction System (Backend Validated) ---
const PRICES = {
    'GOLD-VIP': 150,
    'SPONSOR': 200,
    'SEHZADE': 300,
    'SEHZADE+': 400,
    'SURVIVAL-MOD': 250,
    'SKYBLOCK-MOD': 300,
    'BOXPVP-MOD': 250
};

app.post('/api/shop/purchase', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Unauthorized access. Please login." });
    
    const { item, timeSlot } = req.body;

    if (!PRICES[item]) return res.status(400).json({ error: "Invalid item or rank selected." });
    
    const validSlots = [
        '13:00 - 15:00 (SATURDAY / SUNDAY)',
        '18:00 - 21:00 (SATURDAY / SUNDAY)'
    ];
    if (!validSlots.includes(timeSlot)) return res.status(400).json({ error: "Invalid time slot selected." });

    const user = await User.findById(req.session.userId);
    if (user.credits < PRICES[item]) return res.status(400).json({ error: "Insufficient balance!" });

    user.credits -= PRICES[item];
    await user.save();
    await Order.create({ username: user.username, item, timeSlot, status: 'pending' });

    res.json({ message: "Order processed successfully! Awaiting manual confirmation by administration." });
});

// --- Admin Management ---
app.post('/api/admin/add-credits', async (req, res) => {
    const { username, amount } = req.body;
    try {
        await User.updateOne({ username: username.toLowerCase() }, { $inc: { credits: Number(amount) } });
        res.json({ message: `Successfully updated credits for ${username}.` });
    } catch (e) {
        res.status(500).json({ error: "Failed to update user credits." });
    }
});

app.listen(PORT, () => {
    console.log(`ŞehzadeMC backend initialized on port ${PORT}.`);
});
