// Shared chart.js lazy loader — single import + registration for all pages
let promise = null
export const ensureChart = () => {
  if (!promise) {
    promise = import('chart.js').then(({ Chart, LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip, Legend }) => {
      Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip, Legend)
      return Chart
    })
  }
  return promise
}
