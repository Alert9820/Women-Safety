const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '../public/index.html')));

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
    password: String
});

const User = mongoose.model('User', userSchema);

// Routes
app.post('/signup', async (req, res) => {
    const { name, email, phone, password } = req.body;
    if(!name || !email || !phone || !password){
        return res.json({ success: false, message: "All fields required" });
    }

    try {
        const existingUser = await User.findOne({ email });
        if(existingUser) return res.json({ success: false, message: "Email already exists" });

        const newUser = new User({ name, email, phone, password });
        await newUser.save();
        return res.json({ success: true });
    } catch(err){
        return res.json({ success: false, message: "Server error" });
    }
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if(!email || !password) return res.json({ success: false, message: "All fields required" });

    try {
        const user = await User.findOne({ email, password });
        if(!user) return res.json({ success: false, message: "Invalid credentials" });
        return res.json({ success: true });
    } catch(err){
        return res.json({ success: false, message: "Server error" });
    }
});

// Serve dashboard/main.html
app.get('/main.html', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/main.html'));
});

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
