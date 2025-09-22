const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
require('dotenv').config();
const twilio = require('twilio');

const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.resolve('public')));

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
.then(() => console.log('MongoDB connected'))
.catch(err => console.error('MongoDB connection error:', err));

// User Schema
const userSchema = new mongoose.Schema({
    name: String,
    email: { type: String, unique: true },
    phone: String,
    password: String,
    emergencyContacts: [String] // Array of phone numbers
});

const User = mongoose.model('User', userSchema);

// Twilio Client
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Signup Route
app.post('/signup', async (req, res) => {
    const { name, email, phone, password, emergencyContacts } = req.body;
    if(!name || !email || !phone || !password) return res.json({ success: false, message: "All fields required" });

    try {
        const existingUser = await User.findOne({ email });
        if(existingUser) return res.json({ success: false, message: "Email already exists" });

        const newUser = new User({ name, email, phone, password, emergencyContacts: emergencyContacts || [] });
        await newUser.save();
        return res.json({ success: true, user: newUser });
    } catch(err){
        console.error(err);
        return res.json({ success: false, message: "Server error" });
    }
});

// Login Route
app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if(!email || !password) return res.json({ success: false, message: "All fields required" });

    try {
        const user = await User.findOne({ email, password });
        if(!user) return res.json({ success: false, message: "Invalid credentials" });
        return res.json({ success: true, user });
    } catch(err){
        console.error(err);
        return res.json({ success: false, message: "Server error" });
    }
});

// SOS Route
app.post('/sos', async (req, res) => {
    const { userId, lat, lng } = req.body;
    if(!userId || !lat || !lng) return res.json({ success: false, message: "Missing data" });

    try {
        const user = await User.findById(userId);
        if(!user) return res.json({ success: false, message: "User not found" });

        if(!user.emergencyContacts || user.emergencyContacts.length === 0)
            return res.json({ success: false, message: "No emergency contacts set" });

        const messageBody = `⚠️ EMERGENCY ALERT! ${user.name} needs help! Location: https://www.google.com/maps?q=${lat},${lng}`;

        // Send SMS to each emergency contact
        for(const contact of user.emergencyContacts){
            await client.messages.create({
                body: messageBody,
                from: process.env.TWILIO_PHONE_NUMBER,
                to: contact
            });
        }

        return res.json({ success: true, message: "SOS sent successfully" });
    } catch(err){
        console.error(err);
        return res.json({ success: false, message: "Server error" });
    }
});

// Serve HTML pages
app.get('/', (req, res) => {
    res.sendFile(path.resolve('public/index.html'));
});
app.get('/main.html', (req, res) => {
    res.sendFile(path.resolve('public/main.html'));
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
