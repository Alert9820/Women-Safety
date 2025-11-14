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
const twilioPhone = process.env.TWILIO_PHONE_NUMBER;
const twilioClient = twilio(accountSid, authToken);

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.resolve('public')));

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
.then(() => console.log('✅ MongoDB connected'))
.catch(err => console.error('❌ MongoDB connection error:', err));

// User Schema (same as your existing schema)
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
        console.error(`❌ Twilio SMS Failed for ${phoneNumber}:`, error.message);
        
        // Specific error handling
        let errorMessage = error.message;
        if (error.code === 21211) {
            errorMessage = 'Invalid phone number format';
        } else if (error.code === 21608) {
            errorMessage = 'Number not verified (trial account restriction)';
        } else if (error.code === 21408) {
            errorMessage = 'Permission to send SMS to this number has not been enabled';
        } else if (error.code === 21610) {
            errorMessage = 'Message cannot be sent to this number';
        }
        
        throw new Error(errorMessage);
    }
}

// ===== AUTHENTICATION ROUTES =====
// (YEH SAB SAME RAHEGA - NO CHANGES)

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
// (YEH BHI SAME RAHEGA)

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

        // Create Google Maps link
        const googleMapsLink = `https://maps.google.com/?q=${lat},${lng}`;
        const timestamp = new Date().toLocaleString();
        
        // Prepare emergency message
        const message = `🚨 EMERGENCY ALERT! ${user.name} needs immediate help!\n📍 Location: ${googleMapsLink}\n⏰ Time: ${timestamp}\nPlease check on them immediately!`;

        console.log('📱 Sending SMS via Twilio to:', user.emergencyContacts);

        // Send SMS to all emergency contacts using Twilio
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
                console.error(`❌ SMS Failed for ${contact}:`, smsError.message);
                
                smsResults.push({
                    contact: contact,
                    success: false,
                    error: smsError.message
                });
            }
            
            // Small delay between SMS sends to avoid rate limiting
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
            responseMessage = `🚨 EMERGENCY ALERT SENT! All ${successfulSends} contacts notified via SMS.`;
        } else if (successfulSends > 0) {
            responseMessage = `🚨 EMERGENCY ALERT PARTIALLY SENT! ${successfulSends} out of ${user.emergencyContacts.length} contacts notified.`;
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
                timestamp: timestamp,
                triggeredBy: triggeredBy
            },
            smsResults: smsResults
        });

    } catch(err){
        console.error('❌ SOS Processing Error:', err);
        return res.json({ 
            success: false, 
            message: "Failed to process SOS: " + err.message
        });
    }
});

// ===== VOLUME BUTTON SOS ROUTE WITH TWILIO =====

app.post('/api/sos/volume', async (req, res) => {
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
        const timestamp = new Date().toLocaleString();
        
        // Prepare volume SOS specific message
        const message = `🚨 VOLUME BUTTON EMERGENCY! ${user.name} triggered SOS!\n📍 Location: ${googleMapsLink}\n⏰ Time: ${timestamp}\nPhone might be locked - immediate attention needed!`;

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
                `🔊 Volume SOS sent to ${successfulSends} contacts` :
                "❌ Volume SOS failed",
            details: {
                contactsNotified: successfulSends,
                location: { lat, lng },
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

// ===== TEST SMS ROUTE WITH TWILIO =====

app.get('/api/test-sms', async (req, res) => {
    try {
        const testNumber = '9137403063'; // Your test number
        const testMessage = '🚨 TEST: Guardian Angel Emergency System is working perfectly! Your safety is our priority.';
        
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
            error: error.message
        });
    }
});

// ===== LOCATION TRACKING ROUTES =====
// (YEH SAB SAME RAHEGA - NO CHANGES)

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

        // Save location to history (keep last 50 locations)
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
// (SAME AS BEFORE)

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
            places: places.slice(0, 15) // Return top 15 nearest places
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
// (SAME AS BEFORE)

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
            history: user.sosHistory.reverse() // Latest first
        });
    } catch(err){
        console.error('❌ SOS History Error:', err);
        return res.json({ success: false, message: "Server error" });
    }
});

// ===== SERVE HTML PAGES =====
// (SAME AS BEFORE)

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
    console.log(`🔐 Environment: ${process.env.NODE_ENV || 'development'}`);
});
