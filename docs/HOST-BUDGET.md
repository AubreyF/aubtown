# Linux host budget

Verified on 2026-08-13. Prices exclude tax and may exclude IPv4, backup, or object-storage charges.

## Recommendation

Start on a Hetzner CX43 in Falkenstein or Helsinki with 8 shared x86 vCPUs, 16 GB RAM, and 160 GB local storage. The current post-adjustment price is $18.49 per month before extras. Use a persistent backup target and private Tailscale access.

Set the initial operating budget at $45 per month and a no-surprises ceiling of $110 per month. The gap covers backups, checkpoint object storage, IPv4 if required, and modest transfer. Do not prepay or reserve capacity during the pilot.

Shared CPU is acceptable for Phase 1 and the single-worker pilot because the workload is bursty. It is not a religious commitment. Resize when measurements show any of these conditions during queued work:

- memory exceeds 80 percent for 15 minutes
- swap activity appears during builds
- CPU stays saturated for 15 minutes
- validation duration exceeds 1.5 times its matched baseline in three runs
- Restate or quota sampling misses its service objective because a worker build starves it

The first performance upgrade is a Hetzner CPX42 at $81.99 per month in the European regions. If consistent dedicated CPU is required, use CCX23 at $101.49 per month. DigitalOcean remains the simpler US fallback at $96 per month for 8 shared vCPUs and 16 GiB RAM, before backups.

The architecture does not depend on Hetzner. Standard Linux, Docker, persistent block storage, private networking, and an object-storage API are the deployment contract.

## Why not start larger

Restate and the coordinator are light. The expensive work is repository installation, TypeScript and Rust compilation, tests, and concurrent workers. Concurrency begins at one. Buying dedicated compute before measuring the actual Freed workload would convert uncertainty directly into a recurring invoice, the cloud provider's favorite form of alchemy.

## Evidence sources

- [Hetzner current cloud price adjustment and regional prices](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/)
- [Hetzner cloud plans](https://www.hetzner.com/cloud/)
- [Hetzner shared-resource policy](https://docs.hetzner.com/cloud/servers/faq/)
- [DigitalOcean Droplet and backup pricing](https://www.digitalocean.com/pricing/droplets)
- [Restate single-node Docker durability requirements](https://docs.restate.dev/server/deploy/docker)
