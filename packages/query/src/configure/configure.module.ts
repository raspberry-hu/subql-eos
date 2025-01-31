// Copyright 2020-2022 OnFinality Limited authors & contributors
// SPDX-License-Identifier: Apache-2.0

import {ConnectionOptions} from 'tls';
import {DynamicModule, Global, Module} from '@nestjs/common';
import {getFileContent, CONNECTION_SSL_ERROR_REGEX} from '@subql/common';
import {Pool, PoolConfig} from 'pg';
import {getLogger} from '../utils/logger';
import {getYargsOption} from '../yargs';
import {Config} from './config';
import {debugPgClient} from './x-postgraphile/debugClient';

async function ensurePool(poolConfig: PoolConfig): Promise<Pool> {
  const pgPool = new Pool(poolConfig);
  try {
    await pgPool.connect();
  } catch (e) {
    if (JSON.stringify(e.message).includes(CONNECTION_SSL_ERROR_REGEX)) {
      poolConfig.ssl = undefined;
      return ensurePool(poolConfig);
    }
  }
  return pgPool;
}

@Global()
@Module({})
export class ConfigureModule {
  static async register(): Promise<DynamicModule> {
    const {argv: opts} = getYargsOption();

    const config = new Config({
      name: opts.name,
      playground: opts.playground ?? false,
      unsafe: opts.unsafe ?? false,
    });

    const dbSslOption = () => {
      const sslConfig: ConnectionOptions = {rejectUnauthorized: false};
      if (opts['pg-ca']) {
        try {
          sslConfig.ca = getFileContent(opts['pg-ca'], 'postgres ca cert');
          if (opts['pg-key']) {
            sslConfig.key = getFileContent(opts['pg-key'], 'postgres client key');
          }

          if (opts['pg-cert']) {
            sslConfig.cert = getFileContent(opts['pg-cert'], 'postgres client cert');
          }

          return sslConfig;
        } catch (e) {
          getLogger('db config').error(e);
          throw e;
        }
      }
      return sslConfig;
    };

    const poolConfig: PoolConfig = {
      user: config.get('DB_USER'),
      password: config.get('DB_PASS'),
      host: config.get('DB_HOST_READ') && !opts.subscription ? config.get('DB_HOST_READ') : config.get('DB_HOST'),
      port: config.get('DB_PORT'),
      database: config.get('DB_DATABASE'),
      max: opts['max-connection'],
      statement_timeout: opts['query-timeout'],
      ssl: dbSslOption(),
    };

    const pgPool = await ensurePool(poolConfig);

    pgPool.on('error', (err) => {
      // tslint:disable-next-line no-console
      getLogger('db').error('PostgreSQL client generated error: ', err.message);
    });
    if (opts['query-explain']) {
      pgPool.on('connect', (pgClient) => {
        // Enhance our Postgres client with debugging stuffs.
        debugPgClient(pgClient, getLogger('explain'));
        pgClient._explainResults = [];
      });
    }
    return {
      module: ConfigureModule,
      providers: [
        {
          provide: Config,
          useValue: config,
        },
        {
          provide: Pool,
          useValue: pgPool,
        },
      ],
      exports: [Config, Pool],
    };
  }
}
