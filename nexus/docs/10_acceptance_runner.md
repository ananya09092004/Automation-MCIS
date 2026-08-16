# Acceptance runner

`tools/run_acceptance.py` keeps tests isolated by risk and dependency.

| Command | What it runs |
|---|---|
| `py tools/run_acceptance.py` | Non-live unit, contract, evidence, safety, and documentation checks |
| `py tools/run_acceptance.py --browser` | Above plus the local safe browser demo; no internet or real account |
| `py tools/run_acceptance.py --live` | Above plus Notepad and File Explorer workflows using temporary data |
| `py tools/run_acceptance.py --office` | Above plus Word/Excel/PowerPoint file-format workflows |

The Office stage is intentionally separated because document-format libraries
are optional dependencies. No stage sends email, spends money, accepts
permissions, books, or deletes personal data.
