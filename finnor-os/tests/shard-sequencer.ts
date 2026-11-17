import { relative } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import timings from "./shard-timings.json";

const milliseconds: Readonly<Record<string, number>> = timings.milliseconds;

export class DurationBalancedSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard;
    if (!shard) return files;

    // Use observed GitHub file times, including import and setup. The three
    // statistical partitions divide the old proof's timing. Unmeasured files
    // still run at the median estimated cost.
    const ranked = files.map(file => {
      const path = relative(file.project.config.root, file.moduleId).replaceAll("\\", "/");
      return { file, path, weight: milliseconds[path] ?? timings.defaultMs };
    }).sort((a, b) => b.weight - a.weight || (a.path < b.path ? -1 : Number(a.path > b.path)));

    const bins = Array.from({ length: shard.count }, () => ({ weight: 0, files: [] as TestSpecification[] }));
    for (const item of ranked) {
      const lightest = bins.reduce((first, next) => next.weight < first.weight ? next : first);
      lightest.files.push(item.file);
      lightest.weight += item.weight;
    }
    return bins[shard.index - 1]!.files;
  }
}
