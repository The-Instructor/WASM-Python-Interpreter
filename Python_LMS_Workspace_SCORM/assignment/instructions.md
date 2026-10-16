# Sample Lab: Temperature Converter

In this lab you will write functions that convert temperatures and work with a data file.

### What to do
1. Open **main.py** in the file tree.
2. Complete `c_to_f(celsius)` — return the temperature in Fahrenheit.
   Formula: `F = C × 9 / 5 + 32`
3. Complete `f_to_c(fahrenheit)` — return the temperature in Celsius.
4. Complete `average_f(path)` — read the CSV file at `path` (it has a `celsius` header row), convert every value to Fahrenheit, and return the average **rounded to 1 decimal place**. You can try it with `data/readings.csv`.
5. Finish the program at the bottom so it asks for a Celsius temperature and prints:

```
25.0 C = 77.0 F
```

### Running and testing
* **▶ Run Code** runs your program. When it asks for input, type in the terminal and press **Enter**.
* **✓ Run Tests** checks your work and records your score in D2L. You can run the tests as many times as you like — your best score counts.
* Your work is saved automatically in this browser.

### Grading
| Item | Points |
|---|---|
| Conversion functions | 3 |
| Program output | 2 |
| Data file average (includes a hidden test) | 3 |
| Program uses your function | 1 |
