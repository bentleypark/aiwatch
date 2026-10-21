import { describe, it, expect } from 'vitest'
import { SERVICES, uptimeScopeOf } from '../services'
import type { ServiceConfig } from '../types'

// #1679 — what each service's uptime30d is computed over, pinned per service. #992 dropped Cerebras's
// `statusComponentIds` to fix its breakdown, and the Atlassian uptime scope silently collapsed to the
// Developer Console because the scope is derived from badge fields. A config edit that changes any
// service's uptime scope now fails here, and the snapshot has to be updated on purpose.
//
// The descriptor follows the branch order `fetchService` uses to pick an uptime source. Only the config
// side is pinnable: BetterStack and Datadog scopes are read from the live page.
function uptimeScopeDescriptor(s: ServiceConfig): string {
  if (s.rootlyFeed) return `rootly ${(s.displayComponentIds ?? ['all chart components']).join(',')}`
  if (s.flashdutyFeed) {
    const primary = `flashduty ${[s.flashdutyPrimaryComponentId ?? 'all components'].flat().join(',')}`
    const fallback = s.apiUrl ? uptimeScopeOf(s) : []
    return fallback.length ? `${primary} | atlassian ${fallback.join(',')}` : primary
  }
  if (s.cloudflareStatusComponentIds) return 'none'
  if (s.datadogStatusUrl) return `datadog group ${s.datadogComponentGroupId}`
  if (s.apiUrl) {
    if (s.uptimeOverPageComponents) return 'incident.io page components'
    if (s.incidentIoComponentId) return `incident.io ${[s.statusComponentIds ?? s.incidentIoComponentId].flat().join(',')}`
    if (s.uptimeOverLiveComponents) return 'atlassian live components'
    const atlassian = uptimeScopeOf(s)
    return atlassian.length ? `atlassian ${atlassian.join(',')}` : 'none'
  }
  if (s.awsHealthApi || s.azureRssUrl) return 'none'
  if (s.betterStackUrl) return 'betterstack all page resources'
  if (s.instatusUrl && s.statusComponent) return `instatus name ${s.statusComponent}`
  return 'none'
}

describe('#1679 — every service\'s uptime scope is pinned', () => {
  it('matches the snapshot', () => {
    expect(Object.fromEntries(SERVICES.map((s) => [s.id, uptimeScopeDescriptor(s)]))).toMatchInlineSnapshot(`
      {
        "assemblyai": "atlassian 50txf4qfk2kv",
        "azureopenai": "none",
        "bedrock": "none",
        "bfl": "atlassian ws9rrzk6n2j7,m991l9z7y6jj",
        "cerebras": "atlassian live components",
        "characterai": "atlassian fw8g76r7dqcl",
        "chatgpt": "incident.io 01JMXBNJXGV1T5GT2M9XA83XNG,01JMXBNJXGKKP51D4DEJ2HZJ8Q,01JMXBNJXGGT5SR5DB9J7GYY48,01JSFK5QX36ZRW0TW0ZV0ZYFXQ,01JSYVYQSWMJ9QG35XHP08BHA7,01K6TVGGGDCP0PPGCHXAG3AQX8,01JQ7EKW990MSPSWVXC7VPV2ZJ,01JMXBNJXG1S2D9V65P1ZZTD94,01JMXBNJXG1YMQPPCPCQX3MPA2,01JSG1XMJ9RVJJQ0E85NVSJ2AZ,01KMKFAMWKQ81YWSE1Z18R6VHR,01JNKS9D9S72PMP1938PVFFQN4,01KX45G1SHQQ9DTAX9S4W7FV8G,01KX45G1SH21AX5DT93D4HMF0P,01M3Q6NERHVE2WPPAQRHBAC6XB,01M3Q6NERHS4BG0HQ85VAR1SRH",
        "claude": "atlassian k8w3r06qmzrp",
        "claudeai": "atlassian rwppv331jlwc,bpp5gb3hpjcl",
        "claudecode": "atlassian yyzkbfz2thpt",
        "codex": "incident.io 01KMP3KP5MGE23B80K1EK4S8PV,01KMKFAMWKNQ84Z1766MV08ZDE,01KMP3KP5M8X0EBTVW6KN327EE,01JVCV8YSWZFRSM1G5CVP253SK",
        "cohere": "incident.io 01HQ6CA39NZ5X3PRFPN71Q89TE",
        "copilot": "atlassian pjmpxvq2cmr2,cnnb39dkkk82",
        "cursor": "atlassian rflc60xp5jp2,mwv1g9sc7kdh,k0trcq273dr6,vsny1qv7v86c,2x2chyqwmkzl",
        "deepgram": "atlassian cv8l6gg3cb9d",
        "deepseek": "flashduty 01KY4MVS8BM3F9JSYWACGQVG7A,01KY4MVS8BSBSVW6053QJ37RJE | atlassian j4n367d9mh3x",
        "deepseekapp": "flashduty 01KY4ND2PNYT9FY5W4ZH80VGJ4,01KY4ND2PN1CCNW2MFT5VW713H,01KY4ND2PNJ6MFA4VJ0DSN6M2J,01KY4ND2PNNFFY6QKV67WFJW8N,01KY4ND2PN6EFSJ4RDYDJYPMNK",
        "elevenlabs": "incident.io 01JP2RQVGDHPEEDAFM5KV2MH9P,01JYDTNNSJBT4X90MAC47YPM9S,01JY3H5SJJZNC33AYMAE4SK4TH,01JY3H5SJJD2BMSGSW5FZE08ST,01JY3H5SJJJG47J60JPKX882H8,01JY3H5SJJFKTXYQHG5A8Z1KYH,01JJM5RKYAEWNM3XYRHXM8FJQ3",
        "fal": "instatus name API",
        "fireworks": "incident.io page components",
        "fishaudio": "betterstack all page resources",
        "gemini": "none",
        "grok": "none",
        "groq": "incident.io 01K053E2FAKWKEYHXEV7WAHJBM",
        "helicone": "betterstack all page resources",
        "huggingface": "betterstack all page resources",
        "jina": "atlassian fc5zn3rkh5bd,v6lh7spvvvf5,7b9xrr2ksh44,67hcttb83zzv,skb1snhyjd6h,phbgjfg719q6,d52c7tz1hnpd,b2tt4jb1x7pz,d7nnpf4sr394,dwcjc0rgg6hn,cm0h2r8mw593,3f6qdtwq4yv6,lbtxhdqvr205,yxvtk6kpvycp,895s37lq7d5q",
        "junie": "incident.io 01KX3EN535A0SKSZK3S84949V1",
        "kimi": "atlassian 8psr5dfdld0s",
        "kimiapp": "atlassian sttxgsd2bps7,ckrtmmv96r2z,x3z9ydzr6ywk,smbb3z35s0jl,rf64wcbxt3r2,x0zsqgy57b75,8rkd3yj051gl,lk7q3z0fcylp,p1j9ttb7jwhp,wmn9wzv84k1v,z2zfp65lvb2z",
        "langfuse": "incident.io 01KS5BHY7AKJD8YEM4MFYMB35Z,01KS5BHY7AX99XYA7AS7AAP7QG,01KS5BHY7AH52EZHZQ9TYD53TY",
        "langsmith": "incident.io 01KX6FV0RR5XXJ0SM3NXZRKMBY,01KX6FV0RRSSTKC5V2GPAMCEQR,01KX6FV0RRKA56PXCRWEHJTMXM",
        "luma": "betterstack all page resources",
        "mistral": "rootly 38c479d8-b68b-4259-8361-0f52c7cc5abd,ca6957e1-6702-46d6-a315-c5c2705ea904,02854346-5ace-4d07-8060-fbce92868dee,040448d1-a48a-46a2-b902-738630eb3dc0,54557689-02de-44ef-93a0-b1623fd0e2d8,1682e120-dca1-4fea-b344-e2f8dd12ebd9,42f444f1-0899-4c61-8700-4deff117fbb9,f1e6b7cd-e1fc-44ab-8b7e-f3cfde127193,dd45369c-fe82-4a81-b177-248cecec6fd8,9bee7300-775f-4cb7-b181-d4efa024c4ca,ba78005e-a0b7-498b-8688-dd3529e9780c,5550b7f7-8d2b-4a86-89d7-d842c94f365a,9f221a35-eb8a-411d-8767-3686dbd7881d",
        "modal": "betterstack all page resources",
        "openai": "incident.io 01JMXBRMFE6N2NNT7DG6XZQ6PW,01JP8CD9JR3HR6Y7G4Q75N4DVW,01JMXBRMFEMZK0HPK19RYET250,01JMXBRMFEV0AJ0VVS68N9CD6R,01JMXBRMFE4MAP2BHSJNZ787WX,01JMXBRMFE5ESNNV8JDHVCGSRD,01JMXBRMFEKVBWKK82B44QFMCE,01JMXBRMFEVZ7E0X9GD9FWR9WX,01JMXBRMFEQW613TFE89F45035,01JMXBRMFESJCBGJR10PDD3WCQ,01JSM5RTJWHRWDTS6Q604VEW3B,01M3Q6W0264T1RJS1YEM47CAQJ,01M3Q6W0262E8VW5DE1MJMMN0T,01M534EG9N1SYV22NNJPRGYESP",
        "openrouter": "datadog group 62d944d3-1acb-471b-81a0-099b3da0164f",
        "perplexity": "incident.io 01KZSFD424NN3EYBS78TMVWNEK,01KZSFD424KQ6VQYV4R0KCA30P,01M0TRMC3ED1PG4GRRXXMVNNZ6,01M2R6E5FPASTEW3A3V8TSYHJ0",
        "pinecone": "atlassian r7tngp2p3sjd",
        "replicate": "none",
        "runway": "atlassian w3jcq3dwljp4,2fr8tksxj5ns,hl94rh0mg6xt",
        "stability": "incident.io 01JW9J39X55NDFZTZT3K5NYR48",
        "together": "betterstack all page resources",
        "turbopuffer": "incident.io 01KMGBMBN2JWWWC92RADN719MQ,01K0Q28Y8010Y0QES8NQ9TSA0N,01K0Q28Y8002ZDVXC1HEM8WBRA,01KMGBMBN2VKMTFD9T6WBBY1DQ,01KMGBMBN2JJYP251E9JA8WB1H,01K0Q28Y80F4SGGMEYYG7G9GWZ,01K0Q28Y80DA6WT9WN08K0N96C,01K0Q28Y801TPC8YT7PS1CXVMR,01KMGBMBN21AW19JHKPFJJJFN1,01K0Q28Y80TDVJ2HYNEJ99W98G,01K0Q28Y80K7Y1SSEX7Z2NYXNK,01K0Q28Y80NZ19ARGHR79HTKZJ,01K0Q1X4P70458SR04MTQ2CA7F,01K0Q28Y80TXNQD9N86J2EXSRT,01K0Q28Y80N7CW8FF73CEVK0YD,01M1EB2MF3HY0FGY4G4XKG6NWD,01M1ENXV57AJASWNHCRYDGS5N8,01M1ENXV5779G7VTW967EJHE5H,01M1ENXV572CR9QK3M3RB2236R",
        "twelvelabs": "atlassian mvv53x91b74m",
        "voyageai": "atlassian g74wmxgm0zxr",
        "windsurf": "atlassian h6z52njyz22z,170m7l75sh6m",
        "xai": "none",
      }
    `)
  })

  it('uptimeOverLiveComponents is set only where the badge is the same live set', () => {
    for (const s of SERVICES.filter((x) => x.uptimeOverLiveComponents)) {
      expect(s.displayAllComponents, s.id).toBe(true)
      expect(s.statusComponentId, s.id).toBeTruthy()
      expect(s.statusComponentIds, s.id).toBeUndefined()
    }
  })
})
