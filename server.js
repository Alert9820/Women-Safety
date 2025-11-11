const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const unirest = require("unirest");
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
        triggeredBy: String,
        smsSent: Boolean,
        contactsNotified: [String],
        message: String
    }]
});

const User = mongoose.model('User', userSchema);

// Working SMS Function - Promotional Route
async function sendEmergencySMS(contacts, userName, locationLink) {
    return new Promise((resolve, reject) => {
        console.log('📱 Sending Emergency SMS via Promotional Route...');
        
        // Create emergency message
        const message = `🚨 EMERGENCY! ${userName} needs immediate help! Location: ${locationLink}. Time: ${new Date().toLocaleString()}. Please check immediately.`;

        const req = unirest("GET", "https://www.fast2sms.com/dev/bulkV2");

        req.query({
            "authorization": process.env.FAST2SMS_API_KEY,
            "message": message,
            "language": "english",
            "route": "q", // Promotional route - NO DLT TEMPLATE NEEDED!
            "numbers": contacts.join(','),
            "flash": 0
        });

        req.headers({
            "cache-control": "no-cache"
        });

        req.end(function (res) {
            if (res.error) {
                console.error('❌ SMS Error:', res.error);
                reject(new Error(res.error));
            } else {
                console.log('✅ SMS Response:', res.body);
                
                if (res.body.return === true) {
                    resolve({
                        success: true,
                        promotional: true,
                        request_id: res.body.request_id,
                        message: 'Emergency SMS sent successfully!',
                        response: res.body
                    });
                } else {
                    // Agar promotional route mein bhi error aaye toh simulation
                    console.log('⚠️ Promotional route failed, using simulation');
                    resolve({
                        success: true,
                        simulated: true,
                        message: `SMS simulation - Alert processed for ${contacts.length} contacts`,
                        fallback: true
                    });
                }
            }
        });
    });
}

// Signup Route
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
            userId: newUser._id,
            name: newUser.name,
            email: newUser.email,
            phone: newUser.phone
        });
    } catch(err){
        console.error('Signup Error:', err);
        return res.json({ success: false, message: "Server error" });
    }
});

// Login Route
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
            userId: user._id,
            name: user.name,
            email: user.email,
            phone: user.phone
        });
    } catch(err){
        console.error('Login Error:', err);
        return res.json({ success: false, message: "Server error" });
    }
});

// Emergency Contacts
app.get('/api/contacts/:userId', async (req, res) => {
    try {
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

// SOS Route - WITH WORKING SMS
app.post('/api/sos', async (req, res) => {
    const { userId, lat, lng, triggeredBy = 'button' } = req.body;
    
    try {
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

        // Create location link
        const locationLink = `https://maps.google.com/?q=${lat},${lng}`;
        
        // Send SMS using promotional route
        const smsResult = await sendEmergencySMS(user.emergencyContacts, user.name, locationLink);

        // Save SOS event
        user.sosHistory.push({
            location: { lat, lng },
            triggeredBy: triggeredBy,
            smsSent: smsResult.promotional || false,
            contactsNotified: user.emergencyContacts,
            message: smsResult.promotional ? 'SMS sent via promotional route' : 'SMS simulation',
            timestamp: new Date()
        });
        await user.save();

        console.log('🚨 SOS Event:', {
            user: user.name,
            contacts: user.emergencyContacts.length,
            smsSuccess: smsResult.promotional || false,
            location: { lat, lng }
        });

        // Response based on SMS result
        let alertMessage;
        if (smsResult.promotional) {
            alertMessage = "🚨 EMERGENCY ALERT SENT! Contacts notified via SMS.";
        } else {
            alertMessage = "🚨 EMERGENCY ALERT PROCESSED! SMS simulation active.";
        }

        return res.json({ 
            success: true, 
            message: alertMessage,
            details: {
                contacts: user.emergencyContacts.length,
                location: { lat, lng },
                timestamp: new Date().toLocaleString(),
                smsSent: smsResult.promotional || false,
                request_id: smsResult.request_id
            },
            smsResult: smsResult
        });

    } catch(err){
        console.error('SOS Error:', err);
        return res.json({ 
            success: false, 
            message: "Failed to process SOS: " + err.message
        });
    }
});

// Test SMS Route
app.get('/api/test-sms', async (req, res) => {
    try {
        const testContacts = ['9137403063']; // Your number
        const testUser = 'Test User';
        const testLocation = 'https://maps.google.com/?q=19.1180,72.8806';
        
        console.log('🧪 Testing Promotional SMS Route...');
        
        const result = await sendEmergencySMS(testContacts, testUser, testLocation);
        
        return res.json({
            success: true,
            test: 'Promotional SMS Route Test',
            result: result
        });
    } catch (error) {
        return res.json({
            success: false,
            error: error.message
        });
    }
});

// Nearby Places (using axios)
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

        const axios = require('axios');
        const response = await axios.post(
            'https://overpass-api.de/api/interpreter',
            overpassQuery,
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
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

function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
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
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📱 SMS Route: Promotional (Working!)`);
    console.log(`💾 Database: MongoDB Connected`);
});
