"""The narration of the product video, spoken by a local model (Kokoro-82M-v1.1-zh) and placed
at the scene times of index.html. Runs in its own Python 3.12 environment (see make.sh):

    build/tts-env/bin/python scripts/promo/voice.py build/voice.wav [voice]

Writes one 60-second track (44.1 kHz) with every line at its start time. A line that would run
past the end of its window is spoken a little faster.
"""
import sys
import warnings

warnings.filterwarnings('ignore')

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
from kokoro import KModel, KPipeline  # noqa: E402
from scipy.signal import resample_poly  # noqa: E402

REPO = 'hexgrad/Kokoro-82M-v1.1-zh'
VOICE = sys.argv[2] if len(sys.argv) > 2 else 'zm_033'
SPEED = 0.94  # a little slower than normal: calm, like a keynote
SR_IN, SR = 24000, 44100
LENGTH = 60.0

# (start, must end by, text): the windows follow the scenes in index.html
LINES = [
    (0.5, 4.6, '卡片盒，一个真正属于你的卢曼卡片盒。'),
    (4.9, 8.6, '卢曼用一个卡片盒，写了七十多本书。'),
    (8.7, 10.6, '现在，轮到你了。'),
    (10.8, 14.5, '每张卡片，都有一个永远不变的编号。'),
    (14.6, 16.9, '想法，可以无限生长。'),
    (17.6, 23.2, '双向链接和关系图，让想法之间的联系，一目了然。'),
    (24.0, 25.8, '本地 AI。'),
    (26.4, 30.6, '把一条闪念，整理成一张永久卡片。'),
    (30.9, 35.2, '问问你的卡片盒，它会用你自己的卡片回答。'),
    (35.4, 37.1, '两种引擎。'),
    (37.3, 39.5, 'Windows，Mac，iPhone。'),
    (39.8, 45.4, '点一下，就能同步。设备之间直连，全程加密。'),
    (46.6, 51.8, '每天写一点，看着你的卡片盒，慢慢长大。'),
    (53.4, 57.8, '卡片盒。免费，开源。'),
]

en = KPipeline(lang_code='a', repo_id=REPO, model=False)
model = KModel(repo_id=REPO).eval()
zh = KPipeline(lang_code='z', repo_id=REPO, model=model, en_callable=lambda t: next(en(t)).phonemes)


def speak(text, speed):
    return np.concatenate([r.audio.numpy() for r in zh(text, voice=VOICE, speed=speed)])


def trim(x, thr=0.01):
    idx = np.where(np.abs(x) > thr * np.max(np.abs(x)))[0]
    return x[max(0, idx[0] - 240): idx[-1] + 2400] if len(idx) else x


track = np.zeros(int(LENGTH * SR))
for start, end, text in LINES:
    speed = SPEED
    wav = trim(speak(text, speed))
    if len(wav) / SR_IN > end - start:  # too long for its window: speak a little faster
        speed = min(1.3, SPEED * (len(wav) / SR_IN) / (end - start) * 1.02)
        wav = trim(speak(text, speed))
    wav = resample_poly(wav, 147, 80)  # 24 kHz → 44.1 kHz
    i = int(start * SR)
    track[i:i + len(wav)] += wav[: len(track) - i]
    print(f'{start:5.1f}–{start + len(wav) / SR:5.1f}s (until {end:4.1f})  speed {speed:.2f}  {text}')

track *= 0.89 / np.max(np.abs(track))
sf.write(sys.argv[1] if len(sys.argv) > 1 else 'voice.wav', track, SR)
