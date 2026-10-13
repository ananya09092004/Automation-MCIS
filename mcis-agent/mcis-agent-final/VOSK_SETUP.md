# Local Wake-Word Setup (Vosk) — one-time, no account needed

## Why this exists
"Hey MCIS" detection now runs **fully on your laptop** — no audio leaves
your device until the wake phrase is actually heard. Only after that does
the real command get sent to Groq for accurate transcription. This is the
same privacy model as Alexa/Siri/Google Assistant.

## One-time setup — download the model

1. Download the small English model (~50MB) from:
   https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip

2. Extract it.

3. Place the extracted folder here:
   ```
   mcis-agent-final/
   └── model/
       └── vosk-model-small-en-us-0.15/
           ├── am/
           ├── conf/
           ├── graph/
           └── ... (other Vosk model files)
   ```
   (i.e. the `model` folder sits next to `agent.js`, `voice/`, `commands/`)

4. Run `npm install` (pulls in `vosk-koffi`)

5. `npm start` as usual.

## For Hindi / Indian language wake detection later
Vosk also has Hindi and Indian-English models — same process, just download
a different model zip from https://alphacephei.com/vosk/models and point
`VOSK_MODEL_PATH` env var at it if you want to experiment. For now the
English small model works fine for "Hey MCIS" since it's the same phrase
regardless of what language the actual command is in afterward.

## Note
This is a first pass — like the sox integration earlier, the exact
`vosk-koffi` API may need a small adjustment once tested for real (constructor
option names, etc.). If `npm start` throws an error mentioning `vosk-koffi`,
paste it and it'll get fixed quickly, same as we did for sox.
