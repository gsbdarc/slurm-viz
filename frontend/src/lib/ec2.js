/**
 * EC2-equivalent cost model.
 *
 * Every job is priced as if it had rented the cheapest EC2 instance that fits its requested
 * CPUs, RAM, and GPUs, for the duration it actually ran. This is the single source of truth for
 * pricing: the job table computes costs in JS via `jobCost()`, and the SQL aggregates use the
 * `CASE` expression emitted by `ec2RateSqlExpr()` — both read `EC2_CATALOG`, so there is no
 * second price list to drift out of sync.
 *
 * PRICES ARE HARDCODED and must be re-checked periodically against
 * https://aws.amazon.com/ec2/pricing/on-demand/ (Linux, on-demand, no savings plan).
 */

export const PRICING_REGION = "us-west-2";
export const PRICING_REGION_LABEL = "us-west-2 (Oregon)";
export const PRICING_AS_OF = "2026-08-10";

/**
 * Representative on-demand Linux instances, $/hour in PRICING_REGION.
 *
 *   c6i — compute optimized (2 GB/vCPU)
 *   m6i — general purpose   (4 GB/vCPU)
 *   r6i — memory optimized  (8 GB/vCPU)
 *   x2idn — high memory     (16 GB/vCPU), for the Yen's large-RAM jobs
 *   g5 / p4d / p5 — GPU
 *
 * Memory-optimized families matter here: Yen jobs are frequently high-RAM and low-CPU, and a
 * general-purpose-only catalog would overprice them badly by forcing a huge m6i just for RAM.
 */
export const EC2_CATALOG = [
  // compute optimized
  { type: "c6i.large", vcpu: 2, memGb: 4, gpus: 0, gpuType: null, usdPerHour: 0.085 },
  { type: "c6i.xlarge", vcpu: 4, memGb: 8, gpus: 0, gpuType: null, usdPerHour: 0.17 },
  { type: "c6i.2xlarge", vcpu: 8, memGb: 16, gpus: 0, gpuType: null, usdPerHour: 0.34 },
  { type: "c6i.4xlarge", vcpu: 16, memGb: 32, gpus: 0, gpuType: null, usdPerHour: 0.68 },
  { type: "c6i.8xlarge", vcpu: 32, memGb: 64, gpus: 0, gpuType: null, usdPerHour: 1.36 },
  { type: "c6i.12xlarge", vcpu: 48, memGb: 96, gpus: 0, gpuType: null, usdPerHour: 2.04 },
  { type: "c6i.16xlarge", vcpu: 64, memGb: 128, gpus: 0, gpuType: null, usdPerHour: 2.72 },
  { type: "c6i.24xlarge", vcpu: 96, memGb: 192, gpus: 0, gpuType: null, usdPerHour: 4.08 },
  { type: "c6i.32xlarge", vcpu: 128, memGb: 256, gpus: 0, gpuType: null, usdPerHour: 5.44 },

  // general purpose
  { type: "m6i.large", vcpu: 2, memGb: 8, gpus: 0, gpuType: null, usdPerHour: 0.096 },
  { type: "m6i.xlarge", vcpu: 4, memGb: 16, gpus: 0, gpuType: null, usdPerHour: 0.192 },
  { type: "m6i.2xlarge", vcpu: 8, memGb: 32, gpus: 0, gpuType: null, usdPerHour: 0.384 },
  { type: "m6i.4xlarge", vcpu: 16, memGb: 64, gpus: 0, gpuType: null, usdPerHour: 0.768 },
  { type: "m6i.8xlarge", vcpu: 32, memGb: 128, gpus: 0, gpuType: null, usdPerHour: 1.536 },
  { type: "m6i.12xlarge", vcpu: 48, memGb: 192, gpus: 0, gpuType: null, usdPerHour: 2.304 },
  { type: "m6i.16xlarge", vcpu: 64, memGb: 256, gpus: 0, gpuType: null, usdPerHour: 3.072 },
  { type: "m6i.24xlarge", vcpu: 96, memGb: 384, gpus: 0, gpuType: null, usdPerHour: 4.608 },
  { type: "m6i.32xlarge", vcpu: 128, memGb: 512, gpus: 0, gpuType: null, usdPerHour: 6.144 },

  // memory optimized
  { type: "r6i.large", vcpu: 2, memGb: 16, gpus: 0, gpuType: null, usdPerHour: 0.126 },
  { type: "r6i.xlarge", vcpu: 4, memGb: 32, gpus: 0, gpuType: null, usdPerHour: 0.252 },
  { type: "r6i.2xlarge", vcpu: 8, memGb: 64, gpus: 0, gpuType: null, usdPerHour: 0.504 },
  { type: "r6i.4xlarge", vcpu: 16, memGb: 128, gpus: 0, gpuType: null, usdPerHour: 1.008 },
  { type: "r6i.8xlarge", vcpu: 32, memGb: 256, gpus: 0, gpuType: null, usdPerHour: 2.016 },
  { type: "r6i.12xlarge", vcpu: 48, memGb: 384, gpus: 0, gpuType: null, usdPerHour: 3.024 },
  { type: "r6i.16xlarge", vcpu: 64, memGb: 512, gpus: 0, gpuType: null, usdPerHour: 4.032 },
  { type: "r6i.24xlarge", vcpu: 96, memGb: 768, gpus: 0, gpuType: null, usdPerHour: 6.048 },
  { type: "r6i.32xlarge", vcpu: 128, memGb: 1024, gpus: 0, gpuType: null, usdPerHour: 8.064 },

  // high memory
  { type: "x2idn.16xlarge", vcpu: 64, memGb: 1024, gpus: 0, gpuType: null, usdPerHour: 6.669 },
  { type: "x2idn.24xlarge", vcpu: 96, memGb: 1536, gpus: 0, gpuType: null, usdPerHour: 10.003 },
  { type: "x2idn.32xlarge", vcpu: 128, memGb: 2048, gpus: 0, gpuType: null, usdPerHour: 13.338 },

  // GPU
  { type: "g5.xlarge", vcpu: 4, memGb: 16, gpus: 1, gpuType: "A10G", usdPerHour: 1.006 },
  { type: "g5.2xlarge", vcpu: 8, memGb: 32, gpus: 1, gpuType: "A10G", usdPerHour: 1.212 },
  { type: "g5.4xlarge", vcpu: 16, memGb: 64, gpus: 1, gpuType: "A10G", usdPerHour: 1.624 },
  { type: "g5.8xlarge", vcpu: 32, memGb: 128, gpus: 1, gpuType: "A10G", usdPerHour: 2.448 },
  { type: "g5.16xlarge", vcpu: 64, memGb: 256, gpus: 1, gpuType: "A10G", usdPerHour: 4.096 },
  { type: "g5.12xlarge", vcpu: 48, memGb: 192, gpus: 4, gpuType: "A10G", usdPerHour: 5.672 },
  { type: "g5.24xlarge", vcpu: 96, memGb: 384, gpus: 4, gpuType: "A10G", usdPerHour: 8.144 },
  { type: "g5.48xlarge", vcpu: 192, memGb: 768, gpus: 8, gpuType: "A10G", usdPerHour: 16.288 },
  { type: "p4d.24xlarge", vcpu: 96, memGb: 1152, gpus: 8, gpuType: "A100 40GB", usdPerHour: 32.7726 },
  { type: "p5.48xlarge", vcpu: 192, memGb: 2048, gpus: 8, gpuType: "H100 80GB", usdPerHour: 98.32 },
];

/** Catalog sorted cheapest-first — the scan order for both the JS fit and the generated SQL. */
const BY_PRICE = [...EC2_CATALOG].sort((a, b) => a.usdPerHour - b.usdPerHour);

const LARGEST_CPU = BY_PRICE.filter((i) => i.gpus === 0).at(-1);
const LARGEST_GPU = BY_PRICE.filter((i) => i.gpus > 0).at(-1);

/** AWS bills Linux on-demand per second with a 60-second minimum. */
export const MIN_BILLED_SECONDS = 60;

function fits(instance, cpus, memGb, gpus) {
  if (gpus > 0) {
    // GPU jobs may only land on GPU instances.
    if (instance.gpus < gpus) return false;
  } else if (instance.gpus > 0) {
    // ...and CPU-only jobs never pay for a GPU instance.
    return false;
  }
  return instance.vcpu >= cpus && instance.memGb >= memGb;
}

/**
 * Cheapest instance that fits the request.
 *
 * Returns `{ instance, oversized }`. `oversized` means the job is bigger than anything in the
 * catalog, so the largest instance was used and the resulting cost is a floor, not an estimate.
 */
export function fitInstance({ cpus, memGb, gpus } = {}) {
  const c = Number(cpus) > 0 ? Number(cpus) : 1;
  const m = Number(memGb) > 0 ? Number(memGb) : 0;
  const g = Number(gpus) > 0 ? Number(gpus) : 0;

  const match = BY_PRICE.find((i) => fits(i, c, m, g));
  if (match) return { instance: match, oversized: false };
  return { instance: g > 0 ? LARGEST_GPU : LARGEST_CPU, oversized: true };
}

/**
 * Price one job.
 *
 * `memGb` may be null when ReqMem failed to parse; the fit then falls back to CPU/GPU only and
 * `memUnknown` is set so the UI can flag it rather than quietly understating the cost.
 */
export function jobCost({ cpus, memGb, gpus, elapsedSeconds } = {}) {
  const { instance, oversized } = fitInstance({ cpus, memGb, gpus });
  const seconds = Math.max(Number(elapsedSeconds) || 0, MIN_BILLED_SECONDS);
  const hours = seconds / 3600;
  return {
    instanceType: instance.type,
    gpuType: instance.gpuType,
    hourlyUsd: instance.usdPerHour,
    hours,
    costUsd: instance.usdPerHour * hours,
    oversized,
    memUnknown: memGb == null,
  };
}

const usdLarge = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const usdSmall = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatUsd(value) {
  const n = Number(value);
  if (value == null || Number.isNaN(n)) return "—";
  if (n >= 10_000) return usdLarge.format(n);
  if (n > 0 && n < 0.01) return "<$0.01";
  return usdSmall.format(n);
}

/**
 * Emit a BigQuery `CASE` returning the fitted instance's hourly rate, generated from the same
 * catalog and in the same cheapest-first order as `fitInstance()`.
 *
 * The expressions are wrapped in IFNULL so a null ReqMem or NCPUS falls back to the smallest
 * instance rather than dropping through to the expensive catch-all branch.
 */
export function ec2RateSqlExpr({ cpuExpr, memExpr, gpuExpr }) {
  const cpu = `IFNULL(${cpuExpr}, 1)`;
  const mem = `IFNULL(${memExpr}, 0)`;
  const gpu = `IFNULL(${gpuExpr}, 0)`;

  const branches = BY_PRICE.map((i) => {
    const gpuCond = i.gpus > 0 ? `${gpu} > 0 AND ${gpu} <= ${i.gpus}` : `${gpu} = 0`;
    return `    WHEN ${gpuCond} AND ${cpu} <= ${i.vcpu} AND ${mem} <= ${i.memGb} THEN ${i.usdPerHour}`;
  });

  // Catch-all for jobs larger than anything in the catalog (mirrors `oversized`).
  branches.push(`    WHEN ${gpu} > 0 THEN ${LARGEST_GPU.usdPerHour}`);

  return `CASE\n${branches.join("\n")}\n    ELSE ${LARGEST_CPU.usdPerHour}\n  END`;
}

/**
 * Emit a BigQuery expression for the job's EC2 cost in USD, applying the 60-second billing floor.
 */
export function ec2CostSqlExpr({ cpuExpr, memExpr, gpuExpr, elapsedExpr }) {
  const rate = ec2RateSqlExpr({ cpuExpr, memExpr, gpuExpr });
  return `(${rate}) * GREATEST(IFNULL(${elapsedExpr}, 0), ${MIN_BILLED_SECONDS}) / 3600`;
}

/** Shared disclosure text — rendered wherever a cost is shown. */
export const PRICING_DISCLOSURE =
  `EC2 equivalent: on-demand Linux, ${PRICING_REGION_LABEL}, prices as of ${PRICING_AS_OF}. ` +
  `Each job is priced as the cheapest instance that fits its requested CPU / RAM / GPU, billed ` +
  `for elapsed time (60s minimum). Excludes storage, data transfer, networking, and idle ` +
  `capacity — an actual migration to the cloud would cost more.`;
