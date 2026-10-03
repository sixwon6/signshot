"""Place generated rehearsal narration on the planned 170-second edit, locally."""
from pathlib import Path
import json
import re
import shutil
import subprocess
import textwrap
import wave

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'submission/demo/rehearsal'
TEMP = ROOT / '.expo/pitch-production/audio'
TEMP.mkdir(parents=True, exist_ok=True)
ffmpeg = shutil.which('ffmpeg')
if not ffmpeg:
    raise SystemExit('FFmpeg must be on PATH.')

timeline = json.loads((ROOT / 'submission/demo/timeline.json').read_text(encoding='utf-8'))
alignment = json.loads((OUT / 'voiceover-alignment.json').read_text(encoding='utf-8'))['alignment']
chars = ''.join(alignment['characters'])
original = (ROOT / 'submission/demo/voiceover.txt').read_text(encoding='utf-8').strip()
assert chars == original, 'Alignment must match the approved narration exactly.'
starts = alignment['character_start_times_seconds']
ends = alignment['character_end_times_seconds']
subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-i',
    str(OUT / 'voiceover-continuous-private-preview.mp3'), '-ac', '1', '-ar', '44100',
    '-c:a', 'pcm_s16le', str(TEMP / 'source.wav')], check=True)
with wave.open(str(TEMP / 'source.wav'), 'rb') as w:
    rate = w.getframerate()
    samples = w.readframes(w.getnframes())

total = timeline['totalSeconds']
track = bytearray(total * rate * 2)
captions = []
cues = []
position = 0

def stamp(seconds):
    ms = round(seconds * 1000)
    return f'{ms//3600000:02d}:{ms//60000%60:02d}:{ms//1000%60:02d},{ms%1000:03d}'

for segment in timeline['segments']:
    spoken = segment['voiceover']
    i = chars.index(spoken, position)
    j = i + len(spoken)
    source_start = max(0.0, starts[i] - 0.10)
    source_end = min(len(samples) / (rate * 2), ends[j-1] + 0.13)
    destination = segment['start'] + 0.45
    assert destination + source_end - source_start < segment['end'] - 0.15, segment['title']
    source_byte_start = round(source_start * rate) * 2
    source_byte_end = round(source_end * rate) * 2
    destination_byte = round(destination * rate) * 2
    piece = samples[source_byte_start:source_byte_end]
    track[destination_byte:destination_byte + len(piece)] = piece
    offset = destination - source_start
    cues.append({'title': segment['title'], 'voice_start': round(starts[i]+offset,3),
                 'voice_end': round(ends[j-1]+offset,3), 'planned_end': segment['end']})

    words = list(re.finditer(r'\S+', spoken))
    group = []
    groups = []
    for word in words:
        if group and len(spoken[group[0].start():word.end()]) > 74:
            groups.append(group)
            group = []
        group.append(word)
    if group:
        groups.append(group)
    for group in groups:
        a, b = group[0].start(), group[-1].end()
        lines = textwrap.wrap(spoken[a:b], width=42)
        assert len(lines) <= 2
        start, end = starts[i+a]+offset, ends[i+b-1]+offset
        if captions:
            assert start >= captions[-1][1]
        captions.append((start, end, '\n'.join(lines)))
    position = j

with wave.open(str(TEMP / 'timed.wav'), 'wb') as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(rate)
    w.writeframes(track)

subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-i', str(TEMP / 'timed.wav'),
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '128k',
    str(OUT / 'signshot-170s-private-rehearsal.mp3')], check=True)
(OUT / 'captions-voiceover-timed.srt').write_text('\n\n'.join(
    f'{n}\n{stamp(a)} --> {stamp(b)}\n{line}' for n,(a,b,line) in enumerate(captions,1))+'\n', encoding='utf-8')
(OUT / 'voice-cues.json').write_text(json.dumps({'duration_seconds': total, 'cues': cues}, indent=2), encoding='utf-8')
print(json.dumps({'duration_seconds': total, 'segments': len(cues), 'captions': len(captions),
                  'all_spoken_segments_fit': True, 'source_text_matches': True}))
