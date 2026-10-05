"""Render original Signshot title cards locally. No generation API or credentials."""
from pathlib import Path
import json
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'submission/demo/motion'
OUT.mkdir(parents=True, exist_ok=True)
FFMPEG = shutil.which('ffmpeg')
if not FFMPEG:
    raise SystemExit('FFmpeg must be on PATH.')

def text(value, size, x, y, color='EAE7DD', start=0.0, font='SpaceGrotesk-Medium.ttf'):
    # Fixed authored text only. There are no credentials or user-supplied filter expressions.
    alpha = f'min(1,max(0,(t-{start})/0.45))'
    return (f"drawtext=fontfile=assets/fonts/{font}:text='{value}':fontsize={size}:"
            f"fontcolor=0x{color}:x={x}:y='{y}':alpha='{alpha}'")

intro = [
    text('Signshot', 166, 144, '390+18*pow(1-min(t/0.8,1),3)', start=0.08),
    text('A creative camera for Seeker', 42, 150, 605, start=0.58, font='Manrope-Regular.ttf'),
    text('SOLANA MOBILE / CLOCK IN 2026', 22, 150, 938, color='9BA0A8', start=0.95, font='IBMPlexMono-Regular.ttf'),
]
outro = [
    text('A camera for every day.', 80, 144, 330, start=0.1),
    text('Editions for the photos you choose.', 80, 144, 435, start=0.5),
    text('Signshot', 44, 150, 850, color='7FF0DF', start=1.1),
    text('A creative camera for Seeker', 27, 150, 920, color='9BA0A8', start=1.1, font='Manrope-Regular.ttf'),
]
for name, duration, filters in [('signshot-intro', 4, intro), ('signshot-outro', 6, outro)]:
    filters.append(f'fade=t=out:st={duration-0.3}:d=0.3:color=0x0B0C0E')
    path = OUT / f'{name}.mp4'
    subprocess.run([FFMPEG, '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', f'color=c=0x0B0C0E:s=1920x1080:r=30:d={duration}',
        '-vf', ','.join(filters), '-c:v', 'libx264', '-crf', '18', '-preset', 'medium',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', str(path)], cwd=ROOT, check=True)
    subprocess.run([FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', '-ss', '2',
        '-i', str(path), '-frames:v', '1', str(OUT / f'{name}-poster.png')], cwd=ROOT, check=True)
    print(json.dumps({'file': str(path), 'duration_seconds': duration, 'resolution': '1920x1080', 'fps': 30}))
