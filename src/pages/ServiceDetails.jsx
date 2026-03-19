export default function ServiceDetails({ serviceId }) {
  return (
    <div className="p-6 text-[var(--text1)] mono">
      Service Details {serviceId ? `— ${serviceId}` : ''} — coming soon
    </div>
  )
}
