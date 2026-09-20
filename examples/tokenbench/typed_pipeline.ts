type Order = { id: string; total: number; paid: boolean }
const orders: Order[] = [{ id: "a", total: 12, paid: true }, { id: "b", total: 30, paid: false }, { id: "c", total: 7, paid: true }]
function summarize(os: Order[]): string {
  const paid = os.filter(o => o.paid).reduce((s, o) => s + o.total, 0)
  return `${os.length} orders, ${paid} paid`
}
console.log(summarize(orders))
