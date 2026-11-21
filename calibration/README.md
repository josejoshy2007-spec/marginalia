# Marking calibration

Check how close the app's examiner-style marker is to real marks. Put your own marked items here as JSON.
Real markschemes are copyrighted, so everything in this folder except `example.json` is gitignored.

One object per file (or an array of objects in one file):

```json
{
  "course": "Physics",
  "level": "HL",
  "question": "Explain ...",
  "marks": 3,
  "markscheme_points": ["point one", { "text": "point two", "marks": 2 }],
  "student_answer": "what the student wrote",
  "official_mark": 2
}
```

- `markscheme_points`: strings (1 mark each) or `{text, marks}`. The first word of `question` is taken as the command term.
- `official_mark`: the mark a real examiner or teacher gave.

Run from `frontend/` (one Gemini call per item; key from `GEMINI_API_KEY` or `backend/.env`, never printed):

```
npm run calibrate -- ../calibration
```

It prints the AI mark against the official mark per item, then the mean absolute error and the exact-match rate.

`example.json` is invented to show the format only. It is not from any real paper.
