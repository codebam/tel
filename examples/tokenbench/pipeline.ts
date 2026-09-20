const users = [{ name: "ada", age: 36 }, { name: "bob", age: 17 }, { name: "cyd", age: 24 }]
const adults = users.filter(u => u.age >= 18).sort((a, b) => a.name.localeCompare(b.name))
console.log(adults.map(u => `${u.name}:${u.age}`).join(", "))
console.log(users.reduce((s, u) => s + u.age, 0))
