const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fetch = require('node-fetch');
const twilio = require('twilio');
require('dotenv').config();

const app = express();

// Twilio Configuration
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhone = process.env.TWILIO_PHONE_NUMBER || '+12272306455';
const twilioClient = twilio(accountSid, authToken);

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.resolve('public')));

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/womenSafety', {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
.then(() => console.log('✅ MongoDB connected'))
.catch(err => console.error('❌ MongoDB connection error:', err));

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
        contactsNotified: [String],
        smsResults: [{
            contact: String,
            success: Boolean,
            response: Object,
            error: String
        }]
    }]
});

const User = mongoose.model('User', userSchema);

// ===== TWILIO SMS FUNCTION =====
async function sendSMS(phoneNumber, message) {
    try {
        // Format number for India
        const toNumber = phoneNumber.startsWith('+') ? phoneNumber : `+91${phoneNumber}`;
        
        console.log(`📤 Sending SMS via Twilio to ${toNumber}`);
        
        // Direct Twilio call
        const result = await twilioClient.messages.create({
            body: message,
            from: twilioPhone,
            to: toNumber
        });
        
        console.log(`✅ SMS Sent to ${toNumber}, SID: ${result.sid}`);
        return { 
            success: true, 
            sid: result.sid,
            status: result.status 
        };
        
    } catch (error) {
        console.error(`❌ Twilio SMS Failed for ${phoneNumber}:`, error);
        
        // Detailed error logging
        console.log('Error Details:', {
            code: error.code,
            message: error.message,
            moreInfo: error.more_info
        });
        
        throw error;
    }
}

// ===== AUTHENTICATION ROUTES =====

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
        console.error('❌ Signup Error:', err);
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
        console.error('❌ Login Error:', err);
        return res.json({ success: false, message: "Server error" });
    }
});

// ===== EMERGENCY CONTACTS ROUTES =====

// Get Emergency Contacts
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
        console.error('❌ Get Contacts Error:', err);
        return res.json({ success: false, message: "Server error" });
    }
});

// Update Emergency Contacts
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
            message: "Contacts updated successfully",
            contacts: user.emergencyContacts
        });
    } catch(err){
        console.error('❌ Update Contacts Error:', err);
        return res.json({ success: false, message: "Server error" });
    }
});

// ===== EMERGENCY SOS ROUTE WITH TWILIO =====

app.post('/api/sos', async (req, res) => {
    // Set timeout for SOS request
    req.setTimeout(30000);
    
    const { userId, lat, lng, triggeredBy = 'button' } = req.body;
    
    console.log('🚨 SOS Triggered:', { userId, lat, lng, triggeredBy });
    
    if(!userId || !lat || !lng) {
        return res.json({ success: false, message: "Missing data" });
    }

    try {
        // Validate user ID
        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.json({ success: false, message: "Invalid user ID" });
        }

        // Find user
        const user = await User.findById(userId);
        if(!user) {
            return res.json({ success: false, message: "User not found" });
        }

        // Check emergency contacts
        if(!user.emergencyContacts || user.emergencyContacts.length === 0) {
            return res.json({ success: false, message: "No emergency contacts set" });
        }

        // Create Google Maps link with exact location
        const googleMapsLink = `https://maps.google.com/?q=${lat},${lng}`;
        const mapsShortLink = `https://maps.app.goo.gl/?q=${lat},${lng}`;
        
        const timestamp = new Date().toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            dateStyle: 'medium',
            timeStyle: 'medium'
        });

        // Prepare emergency message with location
        const message = `🚨 EMERGENCY ALERT! 

${user.name} needs immediate help!

📍 Location: ${mapsShortLink}
📌 Exact Coordinates: ${lat.toFixed(6)}, ${lng.toFixed(6)}
⏰ Time: ${timestamp}

Please check on them immediately and contact authorities if needed.

Sent via Guardian Angel Safety App`;

        console.log('📱 Sending SMS to:', user.emergencyContacts);
        console.log('📍 Location:', { lat, lng });
        console.log('📝 Message Length:', message.length);

        // Send SMS to all emergency contacts
        const smsResults = [];
        let successfulSends = 0;

        for (const contact of user.emergencyContacts) {
            try {
                console.log(`📤 Attempting SMS to: ${contact}`);
                const result = await sendSMS(contact, message);
                
                smsResults.push({
                    contact: contact,
                    success: true,
                    response: result
                });
                successfulSends++;
                
                console.log(`✅ SMS Success for ${contact}`);

            } catch (smsError) {
                console.error(`❌ SMS Failed for ${contact}:`, smsError.message);
                
                smsResults.push({
                    contact: contact,
                    success: false,
                    error: smsError.message,
                    code: smsError.code
                });
            }
            
            // Small delay between SMS sends
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // Save SOS event to database
        const sosEvent = {
            location: { lat, lng },
            triggeredBy: triggeredBy,
            timestamp: new Date(),
            contactsNotified: user.emergencyContacts,
            smsResults: smsResults
        };
        
        user.sosHistory.push(sosEvent);
        await user.save();

        console.log('✅ SOS Event Saved:', {
            user: user.name,
            successfulSends: successfulSends,
            totalContacts: user.emergencyContacts.length,
            location: { lat, lng }
        });

        // Prepare response
        let responseMessage;
        if (successfulSends === user.emergencyContacts.length) {
            responseMessage = `🚨 EMERGENCY ALERT SENT! All ${successfulSends} contacts notified via SMS with your location.`;
        } else if (successfulSends > 0) {
            responseMessage = `🚨 EMERGENCY ALERT PARTIALLY SENT! ${successfulSends} out of ${user.emergencyContacts.length} contacts notified with your location.`;
        } else {
            responseMessage = "❌ Failed to send SMS to any contacts. Please try again.";
        }

        return res.json({ 
            success: successfulSends > 0,
            message: responseMessage,
            details: {
                contactsTotal: user.emergencyContacts.length,
                contactsNotified: successfulSends,
                location: { lat, lng },
                googleMapsLink: googleMapsLink,
                timestamp: timestamp,
                triggeredBy: triggeredBy
            },
            smsResults: smsResults
        });

    } catch(err) {
        console.error('❌ SOS Processing Error:', err);
        return res.json({ 
            success: false, 
            message: "SMS service timeout. Please try again."
        });
    }
});

// ===== VOLUME BUTTON SOS ROUTE =====

app.post('/api/sos/volume', async (req, res) => {
    req.setTimeout(30000);
    
    const { userId, lat, lng } = req.body;
    
    console.log('🔊 Volume SOS Triggered:', { userId, lat, lng });
    
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

        // Create Google Maps link
        const googleMapsLink = `https://maps.google.com/?q=${lat},${lng}`;
        const mapsShortLink = `https://maps.app.goo.gl/?q=${lat},${lng}`;
        
        const timestamp = new Date().toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            dateStyle: 'medium',
            timeStyle: 'medium'
        });

        // Volume SOS specific message
        const message = `🚨 VOLUME BUTTON EMERGENCY!

${user.name} triggered SOS using volume buttons!

📍 Location: ${mapsShortLink}
📌 Coordinates: ${lat.toFixed(6)}, ${lng.toFixed(6)}
⏰ Time: ${timestamp}

Phone might be locked - immediate attention needed!

Sent via Guardian Angel Safety App`;

        // Send SMS using Twilio
        const smsResults = [];
        let successfulSends = 0;

        for (const contact of user.emergencyContacts) {
            try {
                const result = await sendSMS(contact, message);
                
                smsResults.push({
                    contact: contact,
                    success: true,
                    response: result
                });
                successfulSends++;

            } catch (smsError) {
                smsResults.push({
                    contact: contact,
                    success: false,
                    error: smsError.message
                });
            }
            
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // Save volume SOS event
        user.sosHistory.push({
            location: { lat, lng },
            triggeredBy: 'volume',
            timestamp: new Date(),
            contactsNotified: user.emergencyContacts,
            smsResults: smsResults
        });
        await user.save();

        return res.json({ 
            success: successfulSends > 0,
            message: successfulSends > 0 ? 
                `🔊 Volume SOS sent to ${successfulSends} contacts with location` :
                "❌ Volume SOS failed",
            details: {
                contactsNotified: successfulSends,
                location: { lat, lng },
                googleMapsLink: googleMapsLink,
                timestamp: timestamp
            }
        });

    } catch(err){
        console.error('❌ Volume SOS Error:', err);
        return res.json({ 
            success: false, 
            message: "Failed to process volume SOS" 
        });
    }
});

// ===== TEST SMS ROUTE =====

app.get('/api/test-sms', async (req, res) => {
    try {
        const testNumber = '9137403063';
        const testMessage = `🚨 TEST: Guardian Angel Emergency System

This is a test message to verify SMS service.

📍 Sample Location: https://maps.google.com/?q=28.6139,77.2090
⏰ Time: ${new Date().toLocaleString()}

Your safety system is working perfectly!`;

        console.log('🧪 Testing Twilio SMS...');
        
        const result = await sendSMS(testNumber, testMessage);

        console.log('✅ Twilio SMS Test Response:', result);

        return res.json({
            success: true,
            message: 'SMS test completed successfully',
            test: 'Twilio SMS Test',
            response: result
        });
    } catch (error) {
        console.error('❌ Twilio SMS Test Error:', error);
        return res.json({
            success: false,
            error: error.message,
            code: error.code
        });
    }
});

// ===== LOCATION TRACKING ROUTES =====

// Update User Location
app.post('/api/location', async (req, res) => {
    const { userId, lat, lng } = req.body;
    
    if(!userId || !lat || !lng) {
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

        // Save location to history
        user.locationHistory.push({ lat, lng });
        if(user.locationHistory.length > 50) {
            user.locationHistory = user.locationHistory.slice(-50);
        }
        
        await user.save();

        return res.json({ 
            success: true, 
            message: "Location updated successfully"
        });
    } catch(err){
        console.error('❌ Location Update Error:', err);
        return res.json({ success: false, message: "Failed to update location" });
    }
});

// ===== NEARBY SAFE PLACES ROUTE =====

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

        const response = await fetch(
            'https://overpass-api.de/api/interpreter',
            {
                method: 'POST',
                body: overpassQuery,
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        const data = await response.json();
        
        const places = data.elements.map(element => {
            return {
                type: element.tags.amenity,
                name: element.tags.name || element.tags.amenity,
                address: element.tags['addr:street'] || 'Address not available',
                lat: element.lat,
                lng: element.lon,
                distance: calculateDistance(lat, lng, element.lat, element.lon)
            };
        });

        // Sort by distance
        places.sort((a, b) => a.distance - b.distance);

        return res.json({ 
            success: true, 
            places: places.slice(0, 15)
        });
    } catch(err){
        console.error('❌ Nearby Places Error:', err);
        return res.json({ 
            success: false, 
            message: "Failed to fetch nearby places",
            places: []
        });
    }
});

// Helper function to calculate distance
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

// ===== SOS HISTORY ROUTE =====

app.get('/api/sos-history/:userId', async (req, res) => {
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
            history: user.sosHistory.reverse()
        });
    } catch(err){
        console.error('❌ SOS History Error:', err);
        return res.json({ success: false, message: "Server error" });
    }
});

// ===== TWILIO SERVICE TEST ROUTE =====

app.get('/api/test-twilio', async (req, res) => {
    try {
        const testNumber = '9137403063';
        const testMessage = '🔧 Twilio Test Message - Guardian Angel System is Working!';
        
        console.log('🧪 Testing Twilio Service...');
        
        const result = await twilioClient.messages.create({
            body: testMessage,
            from: twilioPhone,
            to: `+91${testNumber}`
        });
        
        console.log('✅ Twilio Test Successful:', result.sid);
        
        return res.json({
            success: true,
            message: 'Twilio service is working',
            sid: result.sid
        });
        
    } catch (error) {
        console.error('❌ Twilio Test Failed:', error.message);
        return res.json({
            success: false,
            error: error.message,
            code: error.code
        });
    }
});

// ===== SERVE HTML PAGES =====

app.get('/', (req, res) => {
    res.sendFile(path.resolve('public/index.html'));
});

app.get('/dashboard.html', (req, res) => {
    res.sendFile(path.resolve('public/dashboard.html'));
});

app.get('/sos.html', (req, res) => {
    res.sendFile(path.resolve('public/sos.html'));
});

app.get('/location.html', (req, res) => {
    res.sendFile(path.resolve('public/location.html'));
});

app.get('/safe-places.html', (req, res) => {
    res.sendFile(path.resolve('public/safe-places.html'));
});

app.get('/community.html', (req, res) => {
    res.sendFile(path.resolve('public/community.html'));
});

app.get('/fake-call.html', (req, res) => {
    res.sendFile(path.resolve('public/fake-call.html'));
});

app.get('/settings.html', (req, res) => {
    res.sendFile(path.resolve('public/settings.html'));
});

// ===== START SERVER =====

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📱 SMS Service: Twilio Active`);
    console.log(`📞 Twilio Phone: ${twilioPhone}`);
    console.log(`💾 Database: MongoDB Connected`);
    console.log(`🌍 Frontend: Serving from public folder`);
    console.log(`✅ All systems ready for emergency SOS!`);
});
