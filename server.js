const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

// Serve static HTML files directly
app.use(express.static(__dirname));

const GOOGLE_SHEET_URL = 'https://script.google.com/macros/s/AKfycbyvnnMRVtTdCtH3OWY21ESHLfDGBCCThEDnh8xXkw-Xk6qGwEroDKBIvryXSL3O6bp3/exec';

const TEACHER_PASSCODE = '123qwe,./';

let activeTeacherFreq = 15500; 
const studentDeviceMap = new Map();

// 1. Set Teacher Frequency
app.post('/api/set-teacher-freq', (req, res) => {
  
  const { frequency, passcode } = req.body;
  if (!passcode || passcode !== TEACHER_PASSCODE) {
    return res.status(401).json({ success: false, message: 'Invalid teacher passcode.' });
  }
  if (!frequency) return res.status(400).json({ success: false, message: 'Frequency required.' });

  activeTeacherFreq = parseInt(frequency, 10);
  console.log(`[TEACHER] Audio beacon set to ${activeTeacherFreq} Hz`);
  res.json({ success: true, activeFrequency: activeTeacherFreq });
});

// 2. Mark Student Attendance
app.post('/api/mark-attendance', async (req, res) => {
  const { studentId, deviceUuid, detectedFrequency } = req.body;

  if (!studentId || !deviceUuid || !detectedFrequency) {
    return res.status(400).json({ success: false, message: 'Missing required parameters.' });
  }

  // Frequency Matching Check (+/- 150 Hz offset)
  const freqOffset = Math.abs(detectedFrequency - activeTeacherFreq);
  if (!activeTeacherFreq || freqOffset > 150) {
    console.log(`[REJECTED] Mismatch! Teacher active frequency: ${activeTeacherFreq}Hz | Student submitted: ${detectedFrequency}Hz`);
    return res.status(400).json({ 
      success: false, 
      message: `Frequency mismatch! Faculty active beacon is at ${activeTeacherFreq} Hz.` 
    });
  }

  // Anti-Proxy Check
  if (studentDeviceMap.has(studentId) && studentDeviceMap.get(studentId) !== deviceUuid) {
    console.log(`[ALERT] Device mismatch for Roll Number: ${studentId}`);
    return res.status(403).json({ success: false, message: 'Device mismatch! Account bound to another device.' });
  }
  studentDeviceMap.set(studentId, deviceUuid);

  // Send to Google Apps Script Web App
  try {
    const sheetResponse = await fetch(GOOGLE_SHEET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentId: String(studentId).trim() }),
      redirect: 'follow'
    });

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