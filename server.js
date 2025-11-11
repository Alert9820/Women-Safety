const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

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
    emergencyContacts: [String],
    locationHistory: [{
        lat: Number,
        lng: Number,
        timestamp: { type: Date, default: Date.now }
    }],
    sosHistory: [{
        location: { lat: Number, lng: Number },
        timestamp: { type: Date, default: Date.now },
        triggeredBy: String
    }]
});

const User = mongoose.model('User', userSchema);

// Fast2SMS Configuration
const FAST2SMS_API_KEY = process.env.FAST2SMS_API_KEY;

// Fast2SMS Function
async function sendFast2SMS(contacts, message) {
    try {
        const response = await axios.post('https://www.fast2sms.com/dev/bulkV2', {
            route: 'q',
            message: message,
            language: 'english',
            flash: 0,
            numbers: contacts.join(',')
        }, {
            headers: {
                'Authorization': FAST2SMS_API_KEY,
                'Content-Type': 'application/json'
            }
        });
        
        console.log('SMS Sent:', response.data);
        return response.data;
    } catch (error) {
        console.error('SMS Error:', error.response?.data || error.message);
        throw error;
    }
}

// Signup Route - FIXED
app.post('/api/signup', async (req, res) => {
    const { name, email, phone, password } = req.body;
    if(!name || !email || !phone || !password) {
        return res.json({ success: false, message: "All fields required" });
    }

    try {
        const existingUser = await User.findOne({ email });
        if(existingUser) {
            return res.json({ success: false, message: "Email already exists" });
        }

        const newUser = new User({ 
            name, 
            email, 
            phone, 
            password, 
            emergencyContacts: [] 
        });
        await newUser.save();
        
        return res.json({ 
            success: true, 
            userId: newUser._id, // ✅ MongoDB ObjectId
            name: newUser.name,
            email: newUser.email,
            phone: newUser.phone
        });
    } catch(err){
        console.error('Signup Error:', err);
        return res.json({ success: false, message: "Server error" });
    }
});

// Login Route - FIXED
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    if(!email || !password) {
        return res.json({ success: false, message: "All fields required" });
    }

    try {
        const user = await User.findOne({ email, password });
        if(!user) {
            return res.json({ success: false, message: "Invalid credentials" });
        }
        
        return res.json({ 
            success: true, 
            userId: user._id, // ✅ MongoDB ObjectId
            name: user.name,
            email: user.email,
            phone: user.phone
        });
    } catch(err){
        console.error('Login Error:', err);
        return res.json({ success: false, message: "Server error" });
    }
});

// Emergency Contacts Management - FIXED
app.get('/api/contacts/:userId', async (req, res) => {
    try {
        // ✅ Check if valid MongoDB ObjectId
        if (!mongoose.Types.ObjectId.isValid(req.params.userId)) {
            return res.json({ success: false, message: "Invalid user ID" });
        }

        const user = await User.findById(req.params.userId);
        if(!user) {
            return res.json({ success: false, message: "User not found" });
        }
        
        return res.json({ 
            success: true, 
            contacts: user.emergencyContacts 
        });
    } catch(err){
        console.error('Get Contacts Error:', err);
        return res.json({ success: false, message: "Server error" });
    }
});

app.post('/api/contacts', async (req, res) => {
    const { userId, contacts } = req.body;
    if(!userId || !contacts) {
        return res.json({ success: false, message: "Missing data" });
    }

    try {
        // ✅ Check if valid MongoDB ObjectId
        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.json({ success: false, message: "Invalid user ID" });
        }

        const user = await User.findById(userId);
        if(!user) {
            return res.json({ success: false, message: "User not found" });
        }

        user.emergencyContacts = contacts;
        await user.save();

        return res.json({ 
            success: true, 
            message: "Contacts updated",
            contacts: user.emergencyContacts
        });
    } catch(err){
        console.error('Update Contacts Error:', err);
        return res.json({ success: false, message: "Server error" });
    }
});

// SOS Route with Fast2SMS - FIXED
app.post('/api/sos', async (req, res) => {
    const { userId, lat, lng, triggeredBy = 'button' } = req.body;
    
    if(!userId || !lat || !lng) {
        return res.json({ success: false, message: "Missing data" });
    }

    try {
        // ✅ Check if valid MongoDB ObjectId
        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.json({ success: false, message: "Invalid user ID" });
        }

        const user = await User.findById(userId);
        if(!user) {
            return res.json({ success: false, message: "User not found" });
        }

        if(!user.emergencyContacts || user.emergencyContacts.length === 0) {
            return res.json({ success: false, message: "No emergency contacts set" });
        }

        // Save SOS to history
        user.sosHistory.push({
            location: { lat, lng },
            triggeredBy: triggeredBy
        });
        await user.save();

        // Prepare emergency message
        const googleMapsLink = `https://www.google.com/maps?q=${lat},${lng}`;
        const message = `🚨 EMERGENCY ALERT! ${user.name} needs immediate help! 
Location: ${googleMapsLink}
Time: ${new Date().toLocaleString()}
Please check on them immediately!`;

        // Send SMS via Fast2SMS
        await sendFast2SMS(user.emergencyContacts, message);

        return res.json({ 
            success: true, 
            message: "SOS sent successfully to all emergency contacts",
            contactsNotified: user.emergencyContacts.length
        });
    } catch(err){
        console.error('SOS Error:', err);
        return res.json({ 
            success: false, 
            message: "Failed to send SOS: " + (err.response?.data?.message || err.message)
        });
    }
});

// Get Nearby Safe Places - FIXED (Overpass API)
app.get('/api/nearby-places', async (req, res) => {
    const { lat, lng, radius = 5000 } = req.query;
    
    if(!lat || !lng) {
        return res.json({ success: false, message: "Missing location data" });
    }

    try {
        const overpassQuery = `
            [out:json][timeout:25];
            (
              node["amenity"="police"](around:${radius},${lat},${lng});
              node["amenity"="hospital"](around:${radius},${lat},${lng});
              node["amenity"="clinic"](around:${radius},${lat},${lng});
            );
            out body;
            >;
            out skel qt;
        `;

        const response = await axios.post(
            'https://overpass-api.de/api/interpreter',
            overpassQuery,
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        const places = response.data.elements.map(element => {
            return {
                type: element.tags.amenity,
                name: element.tags.name || element.tags.amenity,
                address: element.tags['addr:street'] || 'Address not available',
                lat: element.lat,
                lng: element.lon,
                distance: calculateDistance(lat, lng, element.lat, element.lon)
            };
        });

        places.sort((a, b) => a.distance - b.distance);

        return res.json({ 
            success: true, 
            places: places.slice(0, 15)
        });
    } catch(err){
        console.error('Nearby Places Error:', err);
        return res.json({ 
            success: false, 
            message: "Failed to fetch nearby places",
            places: []
        });
    }
});

// Helper function to calculate distance
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
        Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
        Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

// Serve HTML pages
app.get('/', (req, res) => {
    res.sendFile(path.resolve('public/index.html'));
});

app.get('/dashboard.html', (req, res) => {
    res.sendFile(path.resolve('public/dashboard.html'));
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
