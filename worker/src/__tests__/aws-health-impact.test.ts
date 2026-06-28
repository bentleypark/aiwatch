import { describe, it, expect } from 'vitest'
import { awsHealthImpact } from '../parsers/aws'

// awsHealthImpact maps an AWS Health event to AIWatch impact (#677). #707 down-classifies a clear
// NON-reliability advisory (no outage signal) to null. #811 moved the classifier to utils and added
// `suspend` to the shared regex — which also widens THIS AWS path; lock that intended behavior here.
describe('awsHealthImpact (#677/#707/#811)', () => {
  const OP = 'AWS_BEDROCK_OPERATIONAL_ISSUE'

  it('a plain OPERATIONAL_ISSUE (no advisory text) is major', () => {
    expect(awsHealthImpact(OP, 'Increased error rates for InvokeModel')).toBe('major')
    expect(awsHealthImpact(OP, '')).toBe('major')
  })

  it('#707 — a compliance/export-control revoke advisory with NO outage signal → null (excluded from Score)', () => {
    expect(awsHealthImpact(OP, 'Per an export control directive, Anthropic has asked us to revoke access to Claude Fable 5 and Mythos 5')).toBe(null)
  })

  it('#811 — a "suspend access" advisory with NO outage signal → null (the shared-regex widening reaches the AWS path)', () => {
    expect(awsHealthImpact(OP, 'We have suspended access to certain Claude models pending review')).toBe(null)
  })

  it('an outage signal ALWAYS wins over advisory wording (never hide a real fault)', () => {
    expect(awsHealthImpact(OP, 'Access suspended following elevated error rates')).toBe('major')
  })

  it('informational/notification typeCodes are minor', () => {
    expect(awsHealthImpact('AWS_BEDROCK_INFORMATIONAL_NOTIFICATION', 'scheduled change')).toBe('minor')
  })
})
