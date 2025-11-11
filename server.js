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
        triggeredBy: String // 'button', 'volume', 'voice', 'auto'
    }]
});

const User = mongoose.model('User', userSchema);

// Fast2SMS Configuration
const FAST2SMS_API_KEY = '6NVQulSjO1MpZgUqWabf8PryEnG9m3tdsAoY5wvXDRI7xL0BkTVLSTUHyshbpXYzuQ74Go5DNFdAqlvM';

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

// Emergency Contacts Management
app.get('/api/contacts/:userId', async (req, res) => {
    try {
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

// SOS Route with Fast2SMS
app.post('/api/sos', async (req, res) => {
    const { userId, lat, lng, triggeredBy = 'button' } = req.body;
    
    if(!userId || !lat || !lng) {
        return res.json({ success: false, message: "Missing data" });
    }

    try {
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

// Volume Button SOS Trigger
app.post('/api/sos/volume', async (req, res) => {
    const { userId, lat, lng } = req.body;
    
    if(!userId || !lat || !lng) {
        return res.json({ success: false, message: "Missing data" });
    }

    try {
        const user = await User.findById(userId);
        if(!user) {
            return res.json({ success: false, message: "User not found" });
        }

        // Save volume-triggered SOS
        user.sosHistory.push({
            location: { lat, lng },
            triggeredBy: 'volume'
        });
        await user.save();

        if(user.emergencyContacts && user.emergencyContacts.length > 0) {
            const googleMapsLink = `https://www.google.com/maps?q=${lat},${lng}`;
            const message = `🚨 VOLUME BUTTON EMERGENCY! ${user.name} triggered SOS! 
Location: ${googleMapsLink}
Time: ${new Date().toLocaleString()}
Phone might be locked - immediate attention needed!`;

            await sendFast2SMS(user.emergencyContacts, message);
        }

        return res.json({ 
            success: true, 
            message: "Volume SOS triggered successfully"
        });
    } catch(err){
        console.error('Volume SOS Error:', err);
        return res.json({ success: false, message: "Failed to trigger SOS" });
    }
});

// Update User Location
app.post('/api/location', async (req, res) => {
    const { userId, lat, lng } = req.body;
    
    if(!userId || !lat || !lng) {
        return res.json({ success: false, message: "Missing data" });
    }

    try {
        const user = await User.findById(userId);
        if(!user) {
            return res.json({ success: false, message: "User not found" });
        }

        // Save location to history (keep last 50 locations)
        user.locationHistory.push({ lat, lng });
        if(user.locationHistory.length > 50) {
            user.locationHistory = user.locationHistory.slice(-50);
        }
        
        await user.save();

        return res.json({ 
            success: true, 
            message: "Location updated"
        });
    } catch(err){
        console.error('Location Update Error:', err);
        return res.json({ success: false, message: "Failed to update location" });
    }
});

// Get Nearby Safe Places (Police Stations, Hospitals)
app.get('/api/nearby-places', async (req, res) => {
    const { lat, lng, radius = 5000 } = req.query;
    
    if(!lat || !lng) {
        return res.json({ success: false, message: "Missing location data" });
    }

    try {
        // Using OpenStreetMap Nominatim API for nearby places
        const places = [];
        
        // Search for police stations
        const policeResponse = await axios.get(
            `https://nominatim.openstreetmap.org/search?format=json&q=police+station&lat=${lat}&lon=${lng}&radius=${radius}`
        );
        
        // Search for hospitals
        const hospitalResponse = await axios.get(
            `https://nominatim.openstreetmap.org/search?format=json&q=hospital&lat=${lat}&lon=${lng}&radius=${radius}`
        );

        // Process police stations
        policeResponse.data.forEach(place => {
            places.push({
                type: 'police',
                name: place.display_name.split(',')[0] || 'Police Station',
                address: place.display_name,
                lat: parseFloat(place.lat),
                lng: parseFloat(place.lon),
                distance: calculateDistance(lat, lng, place.lat, place.lon)
            });
        });

        // Process hospitals
        hospitalResponse.data.forEach(place => {
            places.push({
                type: 'hospital',
                name: place.display_name.split(',')[0] || 'Hospital',
                address: place.display_name,
                lat: parseFloat(place.lat),
                lng: parseFloat(place.lon),
                distance: calculateDistance(lat, lng, place.lat, place.lon)
            });
        });

        // Sort by distance
        places.sort((a, b) => a.distance - b.distance);

        return res.json({ 
            success: true, 
            places: places.slice(0, 20) // Return top 20 nearest places
        });
    } catch(err){
        console.error('Nearby Places Error:', err);
        return res.json({ success: false, message: "Failed to fetch nearby places" });
    }
});

// Helper function to calculate distance between two coordinates
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth's radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
        Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
        Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c; // Distance in km
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
console.log('📱 Fast2SMS Integration: ACTIVE');
console.log('🗺️  OpenStreetMap Integration: ACTIVE');
console.log('🔊 Volume Button SOS: READY');
