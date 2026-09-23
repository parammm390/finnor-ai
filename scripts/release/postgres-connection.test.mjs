import assert from "node:assert/strict"
import { X509Certificate } from "node:crypto"
import test from "node:test"
import { pgConnectionConfig, SUPABASE_ROOT_CA_2021 } from "../../finnor-os/packages/db/postgres-connection.mjs"

test("pins the canonical Supabase root CA and removes URL TLS overrides", () => {
  const certificate = new X509Certificate(SUPABASE_ROOT_CA_2021)
  assert.equal(certificate.subject, "C=US\nST=Delware\nL=New Castle\nO=Supabase Inc\nCN=Supabase Root 2021 CA")
  assert.equal(certificate.fingerprint256, "80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA")

  const config = pgConnectionConfig("postgres://user:password@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=require&sslrootcert=wrong")
  assert.equal(config.connectionString, "postgres://user:password@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres")
  assert.deepEqual(config.ssl, { rejectUnauthorized: true, ca: SUPABASE_ROOT_CA_2021 })
})

test("uses system trust for other remote providers and plaintext only for explicit local targets", () => {
  assert.deepEqual(pgConnectionConfig("postgres://user:password@database.example.com/app"), {
    connectionString: "postgres://user:password@database.example.com/app",
    ssl: { rejectUnauthorized: true },
  })
  assert.deepEqual(pgConnectionConfig("postgres://user:password@127.0.0.1:5432/app"), {
    connectionString: "postgres://user:password@127.0.0.1:5432/app",
  })
})
