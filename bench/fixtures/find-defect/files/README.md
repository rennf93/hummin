# parseCSV

`parseCSV(text)` parses RFC-4180-style CSV:

- Returns an array of row objects. The FIRST line is the header.
- Quoted fields may contain commas and newlines.
- Every data row yields an object with ALL header keys; missing values become "".
- A trailing newline at the end of the file is normal and must not change the result.
