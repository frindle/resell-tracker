# Gift-card OCR service (DORMANT)

Reads gift-card codes off photos, on CPU, in a container of its own. It is
**built, deployable and testable, but switched off** — see [Why it is
dormant](#why-it-is-dormant).

---

## What it is for

Two flows, one invariant.

| | Situation | What OCR does |
|---|---|---|
| **A. Verify** | The card already has a code and there is a photo | Reads the photo and compares. Agreement is silent; disagreement raises a flag. |
| **B. Assisted entry** | There is a photo but no code yet | Proposes codes on a review screen. The user corrects or accepts, then saves. |

**The invariant: OCR never writes a code autonomously.** In flow A a human
typed the code and OCR is only the check. In flow B a human is still the
authority and OCR only saves typing. Nothing is persisted that a human did not
look at.

That is what makes this safe to point at financial records. As *auto-entry*,
OCR would have to be authoritative and every misread would propagate silently.
As a *cross-check*, it only has to disagree usefully — it catches typos instead
of creating them, and a wrong read costs a false flag, not a corrupted record.
It also sidesteps the fact that precision is **unmeasurable** on this data: a
read that is not in the database is UNKNOWN, not wrong, because plenty of
photographed cards were never entered.

---

## Why it is dormant

Penn has decided the *shape* of the flow. He has not said it ships. So:

* Everything is behind `GIFTCARD_OCR_ENABLED`, which must be exactly the string
  `"true"`. Unset, empty, `1`, `yes` and `false` all leave it off.
* With the flag off, every route under `/api/giftcard-ocr/` returns **404** —
  not 403 — so a deployment with OCR disabled is indistinguishable from one
  where these routes were never built.
* `/orders/<id>/giftcard-ocr` calls `notFound()` before rendering anything.
* **Nothing links to it.** No nav entry, no button on the order page, no timer,
  no sync loop. The URL has to be typed.
* No existing code path imports `lib/giftCardOcr.ts` or
  `lib/giftCardOcrVerify.ts`.
* Bringing the `giftcard-ocr` container up while the flag is false is a no-op:
  the app never calls it and it sits idle.

The one thing that is *not* invisible when the flag is off is the database —
see [Schema change](#schema-change).

---

## Architecture

```
resell-tracker (Next.js)                    giftcard-ocr (Python, CPU only)
┌───────────────────────────┐               ┌──────────────────────────────┐
│ lib/giftCardOcr.ts        │  POST /ocr    │ server.py   Flask + waitress │
│   flag gate + HTTP client │──────────────▶│ engine.py   PaddleOCR        │
│ lib/giftCardOcrVerify.ts  │◀──────────────│ variants.py preprocessing    │
│   verdicts, no I/O        │  candidates   │ pins.py     line → candidate │
│ app/api/giftcard-ocr/…    │               └──────────────────────────────┘
│ components/GiftCardOcr…   │                    no DB, no app knowledge
└───────────────────────────┘
```

**Why a separate service rather than a library.** PaddleOCR is Python and pulls
in ~1 GB of wheels and model weights; resell-tracker is Node on `node:22-alpine`
(musl, where paddlepaddle has no wheels at all). There is no version of this
that is an npm dependency. It follows the existing `sidecar/` pattern: its own
Dockerfile, its own macvlan IP, HTTP to the app, no database of its own.

**Where the boundary sits.** The service knows nothing about orders, cards, or
the schema — image bytes in, candidate codes out. Everything about matching,
confidence policy and what counts as a flag lives in `lib/giftCardOcrVerify.ts`
on the app side, where the data is. That means the OCR container can be
restarted, rebuilt or swapped for a different engine without touching a single
decision about what a mismatch means.

**CPU only, deliberately.** `paddlepaddle`, not `paddlepaddle-gpu`; no CUDA base
image; no device reservation in compose. The entire reason PaddleOCR was chosen
over a vision-language model is that it wins *without* a GPU, so it can never
contend for one.

---

## Accuracy

Scored by `giftcard-ocr`'s own `gc-score-pins.py` against codes stored in the
resell-tracker database: 46 confirmed PINs across 16 of 28 photos. A read that
matches a stored 16-character code is confirmed correct; a read that matches
nothing is UNKNOWN, never "wrong" — so these are **recall** numbers and there is
no precision figure to quote.

Prior art, for scale:

| approach | best | cost |
|---|---|---|
| 7 vision-language models, best single variant | 50.8% | 1x |
| VLM best ensemble | 83% | 21x |
| PaddleOCR (CPU), best single variant | 97.8% | 1x |

### What changed when the pipeline was ported

The variant preprocessing was originally macOS CoreImage
(`gc-preprocess.swift`). This container is Pillow/NumPy on Linux, and CoreImage's
photo-effect and temperature filters carry undocumented tone curves that cannot
be reproduced exactly. So the port was **re-measured end to end** rather than
assumed equivalent, on the same 28 images and the same 46 confirmed PINs:

| variant | CoreImage (original) | Python port (this service) |
|---|---|---|
| `grayscale` | 97.8% | 89.1% |
| `normal` | 91.3% | **97.8%** |
| `redchan+stretch14` | 95.7% | 95.7% |
| `redchan` | 93.5% | 95.7% |
| `warmtint` | 89.1% | 95.7% |

Individual variants moved by up to 9 points in both directions — as expected,
since `_mono()` and `_temperature()` are approximations of their CoreImage
counterparts. **`redchan+stretch14` was the only variant that scored identically
under both**, which is why it anchors the shipped ensemble.

The consequence: the pair the original research picked is **not** the best pair
here.

| two-variant ensemble | Python port |
|---|---|
| `redchan+stretch14` + `warmtint` (the original pick) | 97.8% (45/46) |
| **`redchan+stretch14` + `grayscale`** (shipped default) | **100% (46/46)** |
| `redchan+stretch14` + `normal` | 100% (46/46) |

`grayscale` is preferred over `normal` as the partner because it differs from
`redchan+stretch14` on both the colour and the geometry axis, so the two reads
are as independent as the variant set allows.

### PP-OCRv5_mobile: measured, and rejected as the default

The mobile models are about twice as fast. They do **not** hold accuracy — same
images, same variants, same code, only the model set changed:

| | PP-OCRv6_medium (default) | PP-OCRv5_mobile |
|---|---|---|
| best single variant | 97.8% (45/46) | 87.0% (40/46) |
| `redchan+stretch14` + `grayscale` | **100% (46/46)** | 95.7% (44/46) |
| union of all five variants tested | 46/46 | 45/46 |
| sweep wall time, 140 reads, 14 workers | 684 s | 357 s |

Halving the CPU cost of something that runs once per photo upload is not worth
two of forty-six. `medium` stays the default; `OCR_MODEL_SET=mobile` is there
if that trade ever becomes worth making.

### Cost per image

End-to-end through the HTTP service, one 12 MP iPhone HEIC, both variants,
model already loaded, measured on a Xeon E5-2699 v4 @ 2.20 GHz:

| image | latency |
|---|---|
| IMG_3064 | 52.5 s |
| IMG_2520 | 63.7–70.8 s |
| IMG_3273 | 61.2 s |

It does **not** scale with threads: `OMP_NUM_THREADS=4` came in at 52.1 s
against 52.5 s at 1 thread, a difference inside the noise. So this is roughly a
minute of one core per photo, and that is the number any "run it on every
upload" decision has to be made against. `OCR_PRELOAD=true` (the default) pays
the ~40 s model build at container start instead of on the first request.

### Note on the model default

PaddleOCR 3.7.0's *built-in* default happens to be `PP-OCRv6_medium`, which is
what all of the above was measured with. Model names are nevertheless **pinned
explicitly** in `engine.py`, and every dependency is pinned in
`requirements.txt`: the built-in default moves between releases, and a silent
model swap on a rebuild would invalidate these numbers with nothing visibly
changing.

---

## The four verdicts

Two states would be wrong. On the measured set, **12 of 28 photos produced no
database match, for two entirely different reasons**: some are real cards never
entered, and some are Costco receipts that are not gift cards at all (IMG_3065
reads `APPROVED PURCHASE`, `COSTCO WHOLESALE`). Receipts carry 16-digit
transaction barcodes, so a naive design flags every receipt as a mismatch and
trains the user to ignore the flag inside a week.

| verdict | meaning | surfaced as |
|---|---|---|
| `CONFIRMED` | a read equals the entered code | quiet; recorded |
| `MISMATCH` | code-shaped reads exist, none matches | **the flag** |
| `WRONG_CARD` | a read matches a *different* record's code | **flag** — photo is probably on the wrong order |
| `NO_READ` | nothing code-shaped found | not a flag |
| `NOT_APPLICABLE` | two or more receipt markers found | not a flag |

Order of evaluation matters and is tested: a match wins outright (a card
photographed on its receipt is a real thing); receipt detection is checked
*before* mismatch, or every receipt becomes a false flag.

**Comparison is normalisation-aware and nothing more.** Both sides are
uppercased and stripped to `A-Z0-9`, matching `norm()` in `pins.py`, so a stored
`1234-5678` matches a read `12345678`. There is deliberately **no fuzzy
matching, no edit-distance threshold, and no O/0 folding** — a near-match that
silently passes is precisely the typo case the feature exists to catch. An edit
distance *is* computed and attached to the audit record, clearly labelled
diagnostic-only, so a human can see at a glance whether a flag is a one-character
typo or a completely different code. It never influences a verdict.

---

## Schema change

Two nullable columns on `GiftCard`
(`prisma/migrations/20260825215147_add_giftcard_code_provenance`):

```sql
ALTER TABLE "GiftCard" ADD COLUMN "codeOcrAgreement" INTEGER;
ALTER TABLE "GiftCard" ADD COLUMN "codeSource" TEXT;
```

`codeSource` is `manual` | `ocr_confirmed` | `ocr_corrected`, and NULL on every
row that predates this and every row the ordinary gift-card form writes (that
path is untouched). Read NULL as "manual, unknown vintage".

This is the one part of the feature that is not invisible when the flag is off:
it is a migration on a live financial table, and any API response that
serialises a `GiftCard` row will now carry two extra `null` fields. No logic,
computation or UI changes. It is worth it because a code a human typed unaided
and a code a human accepted from an OCR suggestion are **not the same thing**,
and today they would be indistinguishable: if an OCR-assisted code ever turns
out wrong, this is what makes it possible to find the others entered the same
way instead of choosing between trusting all of them and re-checking all of
them. It also yields the accepted-unchanged vs corrected rate, which is the
only real-world accuracy number — no 46-PIN benchmark can produce it.

---

## Running it

### Deploy (Penn deploys; nothing here restarts anything)

```bash
# .env
GIFTCARD_OCR_IP=10.0.12.41          # macvlan address for the container
GIFTCARD_OCR_ENABLED=false          # keep it false; this is the master switch
# GIFTCARD_OCR_SECRET=$(openssl rand -hex 32)   # optional, must match on both

docker-compose build giftcard-ocr
docker-compose up -d giftcard-ocr
```

The build downloads the OCR weights into the image (`preload.py`), so the first
request does not block on a several-hundred-megabyte fetch and a container with
no outbound internet still works. That also makes `docker build` a smoke test:
it runs a real detect+recognise pass and fails the build if the wheel
combination is broken.

### Exercise the service directly

```bash
curl -s http://10.0.12.41:8080/health | jq
curl -s -F file=@card.heic http://10.0.12.41:8080/ocr | jq

# non-default variants, or the noisy every-window fallback
curl -s -F file=@card.heic 'http://10.0.12.41:8080/ocr?variants=grayscale,normal'
curl -s -F file=@card.heic 'http://10.0.12.41:8080/ocr?include_windows=true'
```

HEIC works (`pillow-heif`); so do JPEG and PNG. JSON `{"image_base64": "..."}`
and a raw image body are also accepted.

### Exercise it through the app (requires the flag ON)

```bash
docker-compose up -d app            # with GIFTCARD_OCR_ENABLED=true in .env

curl -H "Cookie: resell_uid=1" http://10.0.12.39:3000/api/giftcard-ocr
curl -H "Cookie: resell_uid=1" -F file=@card.heic http://10.0.12.39:3000/api/giftcard-ocr
curl -H "Cookie: resell_uid=1" http://10.0.12.39:3000/api/giftcard-ocr/orders/884
```

With the flag off all three return `404 Not found`.

### Tests

```bash
npm run test:giftcard-ocr     # verifier verdict logic, no service needed
```

---

## Files

| file | what it is |
|---|---|
| `giftcard-ocr/variants.py` | preprocessing ops, ported from `gc-preprocess.swift` |
| `giftcard-ocr/pins.py` | line reconstruction → candidate codes + their regions |
| `giftcard-ocr/engine.py` | PaddleOCR wrapper, the variant ensemble |
| `giftcard-ocr/server.py` | Flask front end: `GET /health`, `POST /ocr` |
| `giftcard-ocr/preload.py` | build-time weight fetch + smoke test |
| `lib/giftCardOcr.ts` | flag gate, HTTP client, region rotation |
| `lib/giftCardOcrVerify.ts` | verdicts, audit payload, order roll-up — no I/O |
| `lib/giftCardOcrVerify.test.ts` | 16 tests over the verdict boundaries |
| `app/api/giftcard-ocr/route.ts` | direct passthrough, for exercising it |
| `app/api/giftcard-ocr/orders/[id]/route.ts` | analyse an order: verification + suggestions |
| `app/api/giftcard-ocr/orders/[id]/apply/route.ts` | the write — human-submitted values only |
| `app/api/giftcard-ocr/orders/[id]/preview/[attachmentId]/route.ts` | browser-renderable JPEG (HEIC → JPEG) |
| `app/orders/[id]/giftcard-ocr/page.tsx` | the gate |
| `components/GiftCardOcrReview.tsx` | the review screen |

---

## Still to decide before switching it on

1. **What triggers a verification run.** Nothing does today. On photo upload? On
   a nightly pass over orders with both a code and a photo? On demand only? OCR
   is several seconds of CPU per photo, so "on every upload" is a real load
   decision, not a free one.
2. **Where a flag surfaces.** There is no home for `MISMATCH` in the UI yet — no
   badge on the order, no queue, no Pushover. The verdict is computed and
   returned; nobody is told.
3. **Whether verdicts are persisted.** Currently the audit payload is built and
   returned but never stored, deliberately: that was one migration on a live
   financial table already. Storing verdicts means a second table, and it is
   only worth it once something actually surfaces them.
4. **How the review screen is reached.** Nothing links to `/orders/<id>/giftcard-ocr`
   on purpose — adding a button to the order page is a change to a live
   user-facing file, and that was out of scope while dormant.
5. **Unassigned photos.** Only attachments already assigned to an order are
   handled. The bulk-upload/triage pool is arguably the *better* place for
   assisted entry, and `WRONG_CARD` detection would help triage directly.
6. **Whether `MISMATCH` should require both variants to agree.** Today any
   single-variant read is enough to reject a match. That maximises sensitivity
   at the cost of some false flags; the audit record carries per-variant results
   so the threshold can be tightened from real data rather than guessed.
