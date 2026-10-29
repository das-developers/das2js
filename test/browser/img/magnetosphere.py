"""Draws the banner art for test/browser/index.html.

	python3 magnetosphere.py          > magnetosphere.svg
	python3 magnetosphere.py --detail > magnetosphere_detail.svg

Jupiter's magnetosphere, not to scale: planet right, magnetotail streaming
left.  Dipole loops r = L cos^2(lat), squashed on the dayside and stretched
along the magnetodisk on the nightside; open lobe lines form the tail.

The default keeps Jupiter muted so the field lines carry the picture.
--detail adds the planet's colors, the Great Red Spot and auroral ovals; the
ovals are stylized, not where Juno sees them.
"""
import math, random, sys

DETAIL = "--detail" in sys.argv[1:]

W, H = 1200, 260
JX, JY, R = 1000.0, 132.0, 26.0
TILT = -7.0      # degrees: magnetic/torus plane vs. the page

def f(v): return f"{v:.1f}"

def rot(x, y, deg=TILT):
	"""Rotate about Jupiter's center into the tilted magnetic frame"""
	a = math.radians(deg)
	dx, dy = x - JX, y - JY
	return JX + dx*math.cos(a) - dy*math.sin(a), JY + dx*math.sin(a) + dy*math.cos(a)

def rot_hinge(x, y):
	"""Tilt that fades with distance: the magnetodisk is tilted near the
	planet but hinges back to run along the tail"""
	d = math.hypot(x - JX, y - JY)
	return rot(x, y, TILT*math.exp(-max(0.0, d - R)/90.0))

def poly(pts):
	return "M" + " L".join(f"{f(x)},{f(y)}" for x, y in pts)

def loop(L, side, stretch, squash):
	"""One dipole field line of shell L (in R) on side +1 (day) or -1 (night)"""
	latmax = math.acos(math.sqrt(1.0/L))
	pts = []
	n = 90
	for i in range(n + 1):
		lat = -latmax + 2*latmax*i/n
		r = L*R*math.cos(lat)**2
		x = JX + side*r*math.cos(lat)*stretch
		y = JY - r*math.sin(lat)*squash
		pts.append(rot_hinge(x, y) if side < 0 else rot(x, y))
	return poly(pts)

out = []
o = out.append

o(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" '
  f'preserveAspectRatio="xMaxYMid slice" role="img" '
  f'aria-label="Jupiter\'s magnetosphere with its long magnetotail">')
o('<defs>')
o('<linearGradient id="sky" x1="0" y1="0" x2="1" y2="0">'
  '<stop offset="0" stop-color="#05080f"/><stop offset="1" stop-color="#0c1530"/></linearGradient>')
o(f'<radialGradient id="halo" cx="{JX/W:.3f}" cy="{JY/H:.3f}" r="0.45" gradientUnits="objectBoundingBox">'
  '<stop offset="0" stop-color="#2a5aa8" stop-opacity="0.45"/>'
  '<stop offset="1" stop-color="#2a5aa8" stop-opacity="0"/></radialGradient>')
o('<linearGradient id="sheath" x1="0" y1="0" x2="1" y2="0">'
  '<stop offset="0" stop-color="#3d7bd9" stop-opacity="0"/>'
  '<stop offset="1" stop-color="#3d7bd9" stop-opacity="0.16"/></linearGradient>')
o(f'<radialGradient id="planet" cx="0.62" cy="0.38" r="0.75">'
  '<stop offset="0" stop-color="#fff" stop-opacity="0.25"/>'
  '<stop offset="0.6" stop-color="#fff" stop-opacity="0"/>'
  '<stop offset="1" stop-color="#000" stop-opacity="0.55"/></radialGradient>')
o('<filter id="glow" x="-20%" y="-20%" width="140%" height="140%">'
  '<feGaussianBlur stdDeviation="2.2" result="b"/>'
  '<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>')
o('<filter id="soft"><feGaussianBlur stdDeviation="3"/></filter>')
o(f'<clipPath id="disk"><circle cx="{f(JX)}" cy="{f(JY)}" r="{f(R)}"/></clipPath>')
o('</defs>')

# Space, with a glow around the planet
o(f'<rect width="{W}" height="{H}" fill="url(#sky)"/>')
o(f'<rect width="{W}" height="{H}" fill="url(#halo)"/>')

# Stars, seeded so the file is stable
rnd = random.Random(1979)   # Voyager's year at Jupiter
for _ in range(70):
	x, y = rnd.uniform(0, W), rnd.uniform(0, H)
	if math.hypot(x - JX, y - JY) < 60: continue
	o(f'<circle cx="{f(x)}" cy="{f(y)}" r="{rnd.choice((0.5, 0.7, 0.9, 1.2))}" '
	  f'fill="#cfe0ff" opacity="{rnd.uniform(0.25, 0.8):.2f}"/>')

# Magnetopause: blunt on the dayside, flaring into the tail
mp = (f'M0,10 C560,12 1150,30 1150,{f(JY)} C1150,234 560,250 0,252')
o(f'<path d="{mp} Z" fill="url(#sheath)"/>')
o(f'<path d="{mp}" fill="none" stroke="#7fb2ff" stroke-opacity="0.45" '
  f'stroke-width="1.3" filter="url(#glow)"/>')

# Tail lobes: open field lines from the polar caps running off the left edge
o('<g fill="none" stroke="#5aa9ff" stroke-width="1" stroke-opacity="0.4">')
for k, h in enumerate((34, 52, 72, 94)):
	lat = math.radians(62 + 6*k)
	for s in (1, -1):
		x0, y0 = rot(JX - R*math.cos(lat)*0.6, JY - s*R*math.sin(lat))
		c1 = rot(JX - 40 - 10*k, JY - s*(h + 18))
		c2 = rot(JX - 260, JY - s*h)
		x3, y3 = 0, JY - s*h*0.82 + 6
		o(f'<path d="M{f(x0)},{f(y0)} C{f(c1[0])},{f(c1[1])} '
		  f'{f(c2[0])},{f(c2[1])} {f(x3)},{f(y3)}"/>')
o('</g>')

# Plasma sheet: the magnetodisk thinning into the tail current sheet
sheet = poly([rot_hinge(x, JY) for x in range(int(JX - R - 2), -1, -8)])
o(f'<path d="{sheet}" fill="none" stroke="#9fd0ff" stroke-width="2.4" '
  'stroke-opacity="0.55" filter="url(#soft)"/>')
o(f'<path d="{sheet}" fill="none" stroke="#d8ecff" stroke-width="0.8" '
  'stroke-opacity="0.7"/>')

# Closed field lines: squashed by the dayside boundary, stretched on the night
o('<g fill="none" stroke="#5aa9ff" stroke-width="1.1" filter="url(#glow)">')
for L, op in ((1.7, 0.75), (2.3, 0.65), (3.0, 0.55), (3.8, 0.45), (4.7, 0.38)):
	o(f'<path d="{loop(L, +1, 0.95, 0.85)}" stroke-opacity="{op}"/>')
for L, st, op in ((1.7, 1.15, 0.75), (2.3, 1.6, 0.65), (3.0, 2.4, 0.55),
				  (3.8, 3.6, 0.45), (4.7, 5.2, 0.38), (5.6, 7.4, 0.3)):
	o(f'<path d="{loop(L, -1, st, 0.62)}" stroke-opacity="{op}"/>')
o('</g>')

# Io plasma torus, back half (behind the planet)
tor = dict(cx=f(JX), cy=f(JY), rx="56", ry="10")
o(f'<g transform="rotate({TILT} {f(JX)} {f(JY)})">')
o(f'<ellipse cx="{tor["cx"]}" cy="{tor["cy"]}" rx="{tor["rx"]}" ry="{tor["ry"]}" '
  'fill="none" stroke="#ff8a5c" stroke-width="5" stroke-opacity="0.35" filter="url(#soft)"/>')
o('</g>')

# Juno: a stretched polar orbit, detail only, and the three-winged
# spacecraft near apojove drawn last
if DETAIL:
	o(f'<ellipse cx="{f(JX + 6)}" cy="{f(JY - 50)}" rx="13" ry="72" fill="none" '
	  f'stroke="#ffd36b" stroke-width="0.8" stroke-opacity="0.5" stroke-dasharray="3 4" '
	  f'transform="rotate(14 {f(JX + 6)} {f(JY - 50)})"/>')
# Jupiter: cream zones, tan and brown belts, the Great Red Spot, limb shading
o('<g clip-path="url(#disk)">')
o(f'<circle cx="{f(JX)}" cy="{f(JY)}" r="{f(R)}" fill="#e6d2ad"/>')
bands = ((-26, 6, "#b9926a"), (-17, 4, "#cdb08a"), (-9, 5, "#a8774f"),
		 (2, 4, "#d9bf97"), (7, 6, "#9c6a45"), (15, 3, "#c49f78"), (21, 6, "#b48c66"))
for dy, hgt, col in bands:
	o(f'<rect x="{f(JX - R)}" y="{f(JY + dy)}" width="{f(2*R)}" height="{hgt}" '
	  f'fill="{col}" opacity="0.9"/>')
if DETAIL:
	o(f'<ellipse cx="{f(JX + 8)}" cy="{f(JY + 10)}" rx="4.6" ry="2.6" fill="#c1553b"/>')
else:
	# Wash the planet into the blue of the scene
	o(f'<circle cx="{f(JX)}" cy="{f(JY)}" r="{f(R)}" fill="#1c3566" opacity="0.62"/>')
o(f'<circle cx="{f(JX)}" cy="{f(JY)}" r="{f(R)}" fill="url(#planet)"/>')
o('</g>')

# Auroral ovals at both poles
for s in ((1, -1) if DETAIL else ()):
	ax, ay = rot(JX - 3, JY - s*(R - 2.5))
	o(f'<ellipse cx="{f(ax)}" cy="{f(ay)}" rx="9" ry="2.6" fill="none" '
	  f'stroke="#b8f4ff" stroke-width="1.4" stroke-opacity="0.85" filter="url(#glow)" '
	  f'transform="rotate({TILT} {f(ax)} {f(ay)})"/>')

# Io plasma torus, front half (over the planet)
o(f'<g transform="rotate({TILT} {f(JX)} {f(JY)})">')
o(f'<path d="M{f(JX - 56)},{f(JY)} A56,10 0 0 0 {f(JX + 56)},{f(JY)}" fill="none" '
  'stroke="#ff9a6c" stroke-width="2.4" stroke-opacity="0.75" filter="url(#glow)"/>')
o('</g>')

# The Galilean moons along the equator, nearest first
for d, rr, col in ((-56, 2.0, "#e9d36b"), (84, 1.8, "#e8e0d2"),
				   (-122, 2.6, "#b4a693"), (150, 2.4, "#7d7163")):
	mx, my = rot(JX + d, JY)
	o(f'<circle cx="{f(mx)}" cy="{f(my)}" r="{rr}" fill="{col}"/>')

# Juno itself, over everything
sx, sy = JX + 36, JY - 132
o(f'<g transform="translate({f(sx)} {f(sy + 12)})" stroke="#ffe08a" stroke-width="1.6" '
  'stroke-linecap="round">')
for a in (90, 210, 330):
	t = math.radians(a)
	o(f'<line x1="0" y1="0" x2="{f(7*math.cos(t))}" y2="{f(-7*math.sin(t))}"/>')
o('<circle r="1.6" fill="#ffe08a" stroke="none"/>')
o('</g>')

o('</svg>')
sys.stdout.write("\n".join(out) + "\n")
