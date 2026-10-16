# Temperature Converter — SOLUTION (never shipped to students)


def c_to_f(celsius):
    """Return the Fahrenheit equivalent of a Celsius temperature."""
    return celsius * 9 / 5 + 32


def f_to_c(fahrenheit):
    """Return the Celsius equivalent of a Fahrenheit temperature."""
    return (fahrenheit - 32) * 5 / 9


def average_f(path):
    """Read a CSV file with a 'celsius' column and return the average
    temperature in Fahrenheit, rounded to 1 decimal place."""
    with open(path) as f:
        next(f)  # skip header
        values = [c_to_f(float(line)) for line in f if line.strip()]
    return round(sum(values) / len(values), 1)


if __name__ == "__main__":
    celsius = float(input("Enter a temperature in Celsius: "))
    print(f"{celsius} C = {c_to_f(celsius)} F")
