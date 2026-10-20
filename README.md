# TypeMyFile

Upload a `.txt`, `.pdf`, `.docx` or `.doc` file and practise typing its text. Tracks net WPM, raw WPM, accuracy, errors and time.

## How it's built (and why it's safe)

It's a **static, client-side site**: no server code, no database, no accounts. Files are read inside the visitor's browser and are never uploaded. That removes the biggest risks a file-upload site has (stored malware, leaked files, server breaches) and keeps privacy-law obligations minimal.

## Known limits

- Scanned PDFs (images with no text layer) contain no text to extract.
- Old binary `.doc` files are read on a best-effort basis. Saving them as `.docx` gives cleaner text.
