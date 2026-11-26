import { z } from "zod"
import { EmployeeDeskWork } from "@/components/centropy/canvas/EmployeeDesk"

export default async function EmployeeDeskWorkPage({ searchParams }: { searchParams: Promise<{ workId?: string | string[] }> }) {
  const { workId } = await searchParams
  const parsed = z.string().uuid().safeParse(workId)
  return <EmployeeDeskWork workId={parsed.success ? parsed.data : null} />
}
