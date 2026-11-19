# Local infrastructure

`docker/compose.yaml` defines optional PostgreSQL and MongoDB development services,
bound to loopback and backed by named Docker volumes. It is not a deployment plan
or a production configuration. The API foundation does not connect to them yet.

Copy the root `.env.example` to `.env` and replace the example passwords before
running `npm run infra:up`. `npm run infra:down` stops services without deleting
their data. Image tags pin supported release lines; later reproducible performance
experiments should also record exact image digests.
