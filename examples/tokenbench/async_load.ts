const data = '{"id": 1, "name": "item"}'
async function load(raw: string) {
  await new Promise(resolve => setTimeout(resolve, 0))
  return JSON.parse(raw)
}
console.log((await load(data)).name)
