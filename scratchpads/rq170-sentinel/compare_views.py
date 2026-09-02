"""Score the model's orthographic silhouettes against the drawing: IoU plus per-station LE/TE error.
Reference top view: ref/three-view.png rows 16..240, cols 19..620 (nose apex at the bottom), 0.03328 m/px."""
import json, numpy as np
from PIL import Image

PX = 20.0 / 601
fg = np.load('meas/fg.npy')
top = fg.copy(); top[168:, 438:] = False; top[249:, :] = False   # drop the side view without clipping the wing
ref = top[16:241, 19:621]                          # 225 rows x 602 cols
ref = ref[::-1, :]                                 # flip so the nose is at the top like the model raster

meta = json.load(open('meas/model-top.json'))
model = np.array(Image.open('meas/model-top.pgm')) > 0
mpp = meta['mpp']
# resample the reference to the model's metres-per-pixel
rh, rw = ref.shape
ref_img = Image.fromarray((ref * 255).astype(np.uint8)).resize((round(rw * PX / mpp), round(rh * PX / mpp)), Image.BILINEAR)
ref_r = np.array(ref_img) > 127
# align: centre columns, and the nose apex rows
def first_row(m): return int(np.argmax(m.any(axis=1)))
def centre_col(m):
    cols = np.where(m.any(axis=0))[0]; return (cols.min() + cols.max()) / 2
H = max(model.shape[0], ref_r.shape[0]) + 4; W = max(model.shape[1], ref_r.shape[1]) + 4
def place(m):
    out = np.zeros((H, W), bool)
    dy = 2 - first_row(m); dx = int(round(W / 2 - centre_col(m)))
    ys, xs = np.where(m); out[ys + dy, xs + dx] = True
    return out
A, B = place(model), place(ref_r)
inter, union = (A & B).sum(), (A | B).sum()
print(f'top-view IoU {inter / union:.3f}   model area {A.sum()}  ref area {B.sum()}  model-only {(A & ~B).sum()}  ref-only {(B & ~A).sum()}')
# per-station leading / trailing edge (rows) at chosen spans, in metres aft of the nose
cx = W / 2
for xm in (0, 1.75, 3.3, 6.0, 9.0, 9.6):
    col = int(round(cx + xm / mpp))
    def edges(m):
        rows = np.where(m[:, col])[0]
        return (rows.min() - 2) * mpp, (rows.max() - 2) * mpp if len(rows) else (None, None)
    (mle, mte), (rle, rte) = edges(A), edges(B)
    print(f'  x={xm:4.2f}  LE model {mle:5.2f} ref {rle:5.2f} d={mle - rle:+.2f}   TE model {mte:5.2f} ref {rte:5.2f} d={mte - rte:+.2f}')
# ASCII diff: '#' both, 'm' model only, 'r' reference only
step = max(1, W // 100)
for y in range(0, H, step * 2):
    print(''.join('#' if A[y, x] and B[y, x] else 'm' if A[y, x] else 'r' if B[y, x] else '.' for x in range(0, W, step)))
