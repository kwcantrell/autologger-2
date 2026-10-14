# Writes tone.wav: 40 s, 48 kHz mono 16-bit, a sine sweeping 100-500 Hz. Synthetic, no voice.
# Chromium's fake capture device plays it (drive.mjs). Run: python3 tone.py
import math
import struct
import wave

w = wave.open('tone.wav', 'wb')
w.setnchannels(1)
w.setsampwidth(2)
w.setframerate(48000)
fr = bytearray()
for i in range(48000 * 40):
    t = i / 48000
    f = 300 + 200 * math.sin(t * 0.5)
    fr += struct.pack('<h', int(8000 * math.sin(2 * math.pi * f * t)))
w.writeframes(bytes(fr))
w.close()
