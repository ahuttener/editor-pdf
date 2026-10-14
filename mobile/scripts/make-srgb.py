# Gera um perfil ICC v2 sRGB mínimo (matriz + curva), sem licença de terceiros. Uso: python make-srgb.py saida.icc
import struct, sys

def s15(v): return struct.pack('>i', round(v * 65536))
def xyz(x, y, z): return b'XYZ ' + b'\0' * 4 + s15(x) + s15(y) + s15(z)
def text(s): return b'text' + b'\0' * 4 + s.encode('ascii') + b'\0'
def desc(s):
    a = s.encode('ascii') + b'\0'
    return b'desc' + b'\0' * 4 + struct.pack('>I', len(a)) + a + b'\0' * 4 + b'\0' * 4 + b'\0' * 2 + b'\0' + b'\0' * 67
def curve():
    pts = []
    for i in range(1024):
        v = i / 1023
        lin = v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
        pts.append(round(lin * 65535))
    return b'curv' + b'\0' * 4 + struct.pack('>I', len(pts)) + b''.join(struct.pack('>H', p) for p in pts)

# Primárias sRGB adaptadas a D50 (Bradford), como no perfil sRGB IEC61966-2.1
tags = [
    (b'desc', desc('sRGB IEC61966-2.1')),
    (b'cprt', text('No copyright, use freely')),
    (b'wtpt', xyz(0.9642, 1.0, 0.8249)),
    (b'rXYZ', xyz(0.4361, 0.2225, 0.0139)),
    (b'gXYZ', xyz(0.3851, 0.7169, 0.0971)),
    (b'bXYZ', xyz(0.1431, 0.0606, 0.7141)),
    (b'rTRC', curve()),
]
tags += [(b'gTRC', None), (b'bTRC', None)]  # compartilham a curva do vermelho
n = len(tags)
offset = 128 + 4 + 12 * n
table, data, trc = b'', b'', None
for sig, body in tags:
    if body is None:
        table += sig + struct.pack('>II', *trc)
        continue
    while (offset + len(data)) % 4: data += b'\0'
    pos = offset + len(data)
    if sig == b'rTRC': trc = (pos, len(body))
    table += sig + struct.pack('>II', pos, len(body))
    data += body
body = struct.pack('>I', n) + table + data
size = 128 + len(body)
header = struct.pack('>I', size) + b'none' + bytes([2, 0x10, 0, 0]) + b'mntr' + b'RGB ' + b'XYZ ' + b'\0' * 12 + b'acsp' + b'\0' * 4 + b'\0' * 4 + b'\0' * 8 + b'\0' * 8 + struct.pack('>I', 0) + s15(0.9642) + s15(1.0) + s15(0.8249) + b'\0' * 4 + b'\0' * 16 + b'\0' * 28
assert len(header) == 128, len(header)
open(sys.argv[1], 'wb').write(header + body)
