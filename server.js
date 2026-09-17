const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || true }));

// Serve static HTML files directly
app.use(express.static(__dirname));

const GOOGLE_SHEET_URL = process.env.GOOGLE_SHEET_URL;
const TEACHER_PASSCODE = process.env.TEACHER_PASSCODE;
const SESSION_DURATION_MS = 10 * 60 * 1000;
const activeSessions = new Map();
const studentDeviceMap = new Map();
const requestLog = new Map();

function isRateLimited(key, maxRequests, windowMs) {
  const now = Date.now();
  const recentRequests = (requestLog.get(key) || []).filter(timestamp => now - timestamp < windowMs);
  recentRequests.push(now);
  requestLog.set(key, recentRequests);
  return recentRequests.length > maxRequests;
}

function getClientKey(req) {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function isValidFrequency(value) {
  return Number.isInteger(value) && value >= 100 && value <= 22000;
}

function isValidStudentId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{2,32}$/.test(value.trim());
}

// 1. Set Teacher Frequency
app.post('/api/set-teacher-freq', (req, res) => {
  const { frequency, passcode } = req.body;
  if (isRateLimited(`teacher:${getClientKey(req)}`, 5, 60 * 1000)) {
    return res.status(429).json({ success: false, message: 'Too many attempts. Try again later.' });
  }
  if (!TEACHER_PASSCODE || !passcode || passcode !== TEACHER_PASSCODE) {
    return res.status(401).json({ success: false, message: 'Invalid teacher passcode.' });
  }
  const numericFrequency = Number(frequency);
  if (!isValidFrequency(numericFrequency)) {
    return res.status(400).json({ success: false, message: 'Frequency must be between 100 and 22000 Hz.' });
  }

  const sessionToken = crypto.randomBytes(6).toString('base64url');
  const expiresAt = Date.now() + SESSION_DURATION_MS;
  activeSessions.clear();
  activeSessions.set(sessionToken, { frequency: numericFrequency, expiresAt });
  console.log(`[TEACHER] Audio beacon set to ${numericFrequency} Hz`);
  res.json({ success: true, activeFrequency: numericFrequency, sessionToken, expiresAt });
});

// 2. Mark Student Attendance
app.post('/api/mark-attendance', async (req, res) => {
  const { studentId, deviceUuid, detectedFrequency, sessionToken } = req.body;

  if (isRateLimited(`student:${getClientKey(req)}`, 20, 60 * 1000)) {
    return res.status(429).json({ success: false, message: 'Too many requests. Try again later.' });
  }
  if (!isValidStudentId(studentId) || typeof deviceUuid !== 'string' || deviceUuid.length < 10 || deviceUuid.length > 100) {
    return res.status(400).json({ success: false, message: 'Missing required parameters.' });
  }

  const session = activeSessions.get(sessionToken);
  if (!session || session.expiresAt <= Date.now()) {
    activeSessions.delete(sessionToken);
    return res.status(400).json({ success: false, message: 'Attendance session is missing or expired.' });
  }

  const numericDetectedFrequency = Number(detectedFrequency);
  const freqOffset = Math.abs(numericDetectedFrequency - session.frequency);
  if (!isValidFrequency(numericDetectedFrequency) || freqOffset > 150) {
    console.log(`[REJECTED] Frequency mismatch for student ${studentId}`);
    return res.status(400).json({ success: false, message: 'Detected frequency does not match the active beacon.' });
  }

  // Anti-Proxy Check
  if (studentDeviceMap.has(studentId) && studentDeviceMap.get(studentId) !== deviceUuid) {
    console.log(`[ALERT] Device mismatch for Roll Number: ${studentId}`);
    return res.status(403).json({ success: false, message: 'Device mismatch! Account bound to another device.' });
  }
  studentDeviceMap.set(studentId, deviceUuid);

  if (!GOOGLE_SHEET_URL) {
    return res.status(500).json({ success: false, message: 'Google Sheets backend is not configured.' });
  }

  try {
    const sheetResponse = await fetch(GOOGLE_SHEET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentId: String(studentId).trim() }),
      redirect: 'follow'
    });

    if (!sheetResponse.ok) {
      throw new Error(`Google Sheets returned HTTP ${sheetResponse.status}`);
    }
    const responseData = await sheetResponse.json();

    if (responseData.status === 'success') {
      console.log(`[SUCCESS] Marked PRESENT for Roll Number: ${studentId}`);
      res.json({ success: true, message: `Marked PRESENT for Roll Number: ${studentId}!` });
    } else {
      console.log(`[SHEET ERROR] ${responseData.message}`);
      res.status(400).json({ success: false, message: responseData.message || 'Roll number not found in sheet.' });
    }

  } catch (err) {
    console.error('[ERROR] Google Sheet fetch error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update Google Sheet backend.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Attendance Server running on port ${PORT}`));