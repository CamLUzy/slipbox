"""Music + narration for the product video: the music ducks under the voice.

    python3 scripts/promo/mix.py build/music.wav build/voice.wav build/mix.wav
"""
import sys
import wave

import numpy as np
from scipy.ndimage import maximum_filter1d
from scipy.signal import butter, fftconvolve, sosfilt

SR = 44100


def read(path):
    with wave.open(path) as w:
        assert w.getframerate() == SR
        x = np.frombuffer(w.readframes(w.getnframes()), dtype='<i2').astype(float) / 32767
        return x.reshape(-1, w.getnchannels())


def smooth(env, attack, release):
    """One-pole follower: rises in `attack` seconds, falls in `release`."""
    a, r = np.exp(-1 / (attack * SR)), np.exp(-1 / (release * SR))
    out = np.empty_like(env)
    y = 0.0
    for i, v in enumerate(env):
        y = a * y + (1 - a) * v if v > y else r * y + (1 - r) * v
        out[i] = y
    return out


music = read(sys.argv[1])
voice = read(sys.argv[2])[:, 0]
n = min(len(music), len(voice))
music, voice = music[:n], voice[:n]

# voice: no rumble, a little presence, a touch of room
voice = sosfilt(butter(2, 90, 'high', fs=SR, output='sos'), voice)
voice = voice + 0.25 * sosfilt(butter(2, [2500, 6000], 'band', fs=SR, output='sos'), voice)
rng = np.random.default_rng(3)
t = np.arange(int(0.9 * SR)) / SR
ir = rng.standard_normal(len(t)) * np.exp(-t * 7)
room = fftconvolve(voice, ir / np.sqrt(np.sum(ir ** 2)))[:n]
voice = voice + 0.06 * room * np.max(np.abs(voice)) / np.max(np.abs(room))

# levels by loudness: speech at -16 dB RMS; music at -19 dB on its own and about 11 dB lower
# while someone speaks (looks ahead 80 ms, comes back in 0.6 s)
db = lambda x: 20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-12)
speaking = maximum_filter1d((np.abs(voice) > 0.02 * np.max(np.abs(voice))).astype(float), size=int(0.25 * SR))
speaking = np.roll(speaking, -int(0.08 * SR))
voice *= 10 ** ((-16 - db(voice[speaking > 0])) / 20)
music *= 10 ** ((-19 - db(music[speaking == 0])) / 20)
gain = 1 - 0.72 * smooth(speaking[::4], 0.08, 0.6).repeat(4)[:n]
ducked = music * gain[:, None]
on = speaking > 0
print('speech %.1f dB, music under it %.1f dB, music alone %.1f dB' % (db(voice[on]), db(ducked[on]), db(ducked[~on])))

mix = ducked + voice[:, None]
peak = np.max(np.abs(mix))
mix = np.tanh(mix / peak * 1.2) / np.tanh(1.2) * min(0.89, peak)  # soft limiter, peak about -1 dB
with wave.open(sys.argv[3], 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((mix * 32767).astype('<i2').tobytes())
print('mix: %.1fs' % (n / SR))
