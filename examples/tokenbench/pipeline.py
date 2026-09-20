users = [{"name": "ada", "age": 36}, {"name": "bob", "age": 17}, {"name": "cyd", "age": 24}]
adults = sorted((u for u in users if u["age"] >= 18), key=lambda u: u["name"])
print(", ".join(f"{u['name']}:{u['age']}" for u in adults))
print(sum(u["age"] for u in users))
