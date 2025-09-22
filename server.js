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
app.use(express.static(path.resolve('public'))); // public folder serve

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
.then(() => console.log('MongoDB connected'))
.catch(err => console.error('MongoDB connection error:', err));

// New UserX Schema
const userXSchema = new mongoose.Schema({
    name: { type: String, default: "x" },
    email: { type: String, unique: true, default: "x" },
    phone: { type: String, default: "x" },
    password: { type: String, default: "x" },
    emergencyContacts: { type: [String], default: ["x"] }
});

const UserX = mongoose.model('userx', userXSchema);

// Twilio Client
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Routes

// Signup
app.post('/signup', async (req, res) => {
    const { name, email, phone, password, emergencyContacts } = req.body;
    if(!name || !email || !phone || !password){
        return res.json({ success: false, message: "All fields required" });
    }

    try {
        const existingUser = await UserX.findOne({ email });
        if(existingUser) return res.json({ success: false, message: "Email already exists" });

        const newUser = new UserX({
            name,
            email,
            phone,
            password,
            emergencyContacts: emergencyContacts || []
        });

        await newUser.save();
        return res.json({ success: true, message: "Signup successful", userId: newUser._id });
    } catch(err){
        console.error(err);
        return res.json({ success: false, message: "Server error" });
    }
});

// Login
app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if(!email || !password) return res.json({ success: false, message: "All fields required" });

    try {
        const user = await UserX.findOne({ email, password });
        if(!user) return res.json({ success: false, message: "Invalid credentials" });

        return res.json({ success: true, user });
    } catch(err){
        console.error(err);
        return res.json({ success: false, message: "Server error" });
    }
});

// SOS - Send SMS with current location
app.post('/sos', async (req, res) => {
    const { userId, lat, lng } = req.body;
    if(!userId || !lat || !lng) return res.json({ success: false, message: "Missing data" });

    try {
        const user = await UserX.findById(userId);
        if(!user) return res.json({ success: false, message: "User not found" });

        const messageBody = `⚠️ EMERGENCY ALERT! ${user.name} needs help! Location: https://www.google.com/maps?q=${lat},${lng}`;

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

// Serve frontend files
app.get('/', (req, res) => {
    res.sendFile(path.resolve('public/index.html'));
});

app.get('/main.html', (req, res) => {
    res.sendFile(path.resolve('public/main.html'));
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
