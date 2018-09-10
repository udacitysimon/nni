/**
 * Copyright (c) Microsoft Corporation
 * All rights reserved.
 *
 * MIT License
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
 * to permit persons to whom the Software is furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED *AS IS*, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
 * BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

'use strict';

import { Request, Response, Router } from 'express';
import * as path from 'path';

import * as component from '../common/component';
import { DataStore, MetricDataRecord, TrialJobInfo } from '../common/datastore';
import { NNIError, NNIErrorNames } from '../common/errors';
import { isNewExperiment } from '../common/experimentStartupInfo';
import { getLogger, Logger } from '../common/log';
import { ExperimentProfile, Manager, TrialJobStatistics} from '../common/manager';
import { RestServer } from './server';
import { TensorBoard } from './tensorboard';

class NNIRestHandler {
    private restServer: RestServer;
    private nniManager: Manager;
    private tb: TensorBoard;
    private log: Logger;

    constructor(rs: RestServer) {
        this.nniManager = component.get(Manager);
        this.restServer = rs;
        this.tb = new TensorBoard();
        this.log = getLogger();
    }

    public createRestHandler(): Router {
        const router: Router = Router();

        // tslint:disable-next-line:typedef
        router.use((req: Request, res: Response, next) => {
            this.log.info(`${req.method}: ${req.url}: body:\n${JSON.stringify(req.body, undefined, 4)}`);
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
            res.header('Access-Control-Allow-Methods', 'PUT,POST,GET,DELETE,OPTIONS');

            res.setHeader('Content-Type', 'application/json');
            next();
        });

        this.checkStatus(router);
        this.getExperimentProfile(router);
        this.updateExperimentProfile(router);
        this.startExperiment(router);
        this.stopExperiment(router);
        this.getTrialJobStatistics(router);
        this.setClusterMetaData(router);
        this.listTrialJobs(router);
        this.getTrialJob(router);
        this.addTrialJob(router);
        this.cancelTrialJob(router);
        this.getMetricData(router);
        this.getExample(router);
        this.getTriedParameters(router);
        this.startTensorBoard(router);
        this.stopTensorBoard(router);

        return router;
    }

    private handle_error(err: Error, res: Response): void {
        this.log.info(err);

        if (err instanceof NNIError && err.name === NNIErrorNames.NOT_FOUND) {
            res.status(404);
        } else {
            res.status(500);
        }
        res.send({
            error: err.message
        });
    }

    // TODO add validators for request params, query, body
    private checkStatus(router: Router): void {
        router.get('/check-status', (req: Request, res: Response) => {
            const ds: DataStore = component.get<DataStore>(DataStore);
            ds.init().then(() => {
                res.send();
            }).catch(async (err: Error) => {
                this.handle_error(err, res);
                this.log.error(err.message);
                this.log.error(`Database initialize failed, stopping rest server...`);
                await this.restServer.stop();
            });
        });
    }

    private getExperimentProfile(router: Router): void {
        router.get('/experiment', (req: Request, res: Response) => {
            this.nniManager.getExperimentProfile().then((profile: ExperimentProfile) => {
                res.send(profile);
            }).catch((err: Error) => {
                this.handle_error(err, res);
            });
        });
    }

    private updateExperimentProfile(router: Router): void {
        router.put('/experiment', (req: Request, res: Response) => {
            this.nniManager.updateExperimentProfile(req.body, req.query.update_type).then(() => {
                res.send();
            }).catch((err: Error) => {
                this.handle_error(err, res);
            });
        });
    }

    private startExperiment(router: Router): void {
        router.post('/experiment', (req: Request, res: Response) => {
            if (isNewExperiment()) {
                this.nniManager.startExperiment(req.body).then((eid: string) => {
                    res.send({
                        experiment_id: eid
                    });
                }).catch((err: Error) => {
                    this.handle_error(err, res);
                });
            } else {
                this.nniManager.resumeExperiment().then(() => {
                    res.send();
                }).catch((err: Error) => {
                    this.handle_error(err, res);
                });
            }
        });
    }

    private stopExperiment(router: Router): void {
        router.delete('/experiment', async (req: Request, res: Response) => {
            try {
                await this.tb.cleanUp();
                await this.nniManager.stopExperiment();
                res.send();
                this.log.debug('Stopping rest server');
                await this.restServer.stop();
            } catch (err) {
                this.handle_error(err, res);
            }
        });
    }

    private getTrialJobStatistics(router: Router): void {
        router.get('/job-statistics', (req: Request, res: Response) => {
            this.nniManager.getTrialJobStatistics().then((statistics: TrialJobStatistics[]) => {
                res.send(statistics);
            }).catch((err: Error) => {
                this.handle_error(err, res);
            });
        });
    }

    private setClusterMetaData(router: Router): void {
        router.put('/experiment/cluster-metadata', async (req: Request, res: Response) => {
            // tslint:disable-next-line:no-any
            const metadata: any = req.body;
            const keys: string[] = Object.keys(metadata);
            try {
                for (const key of keys) {
                    await this.nniManager.setClusterMetadata(key, JSON.stringify(metadata[key]));
                }
                res.send();
            } catch (err) {
                this.handle_error(err, res);
            }
        });
    }

    private listTrialJobs(router: Router): void {
        router.get('/trial-jobs', (req: Request, res: Response) => {
            this.nniManager.listTrialJobs(req.query.status).then((jobInfos: TrialJobInfo[]) => {
                jobInfos.forEach((trialJob: TrialJobInfo) => {
                    this.setErrorPathForFailedJob(trialJob);
                });
                res.send(jobInfos);
            }).catch((err: Error) => {
                this.handle_error(err, res);
            });
        });
    }

    private getTrialJob(router: Router): void {
        router.get('/trial-jobs/:id', (req: Request, res: Response) => {
            this.nniManager.getTrialJob(req.params.id).then((jobDetail: TrialJobInfo) => {
                const jobInfo: TrialJobInfo = this.setErrorPathForFailedJob(jobDetail);
                res.send(jobInfo);
            }).catch((err: Error) => {
                this.handle_error(err, res);
            });
        });
    }

    private addTrialJob(router: Router): void {
        router.post('/trial-jobs', async (req: Request, res: Response) => {
            this.nniManager.addCustomizedTrialJob(JSON.stringify(req.body)).then(() => {
                res.send();
            }).catch((err: Error) => {
                this.handle_error(err, res);
            });
        });
    }

    private cancelTrialJob(router: Router): void {
        router.delete('/trial-jobs/:id', async (req: Request, res: Response) => {
            this.nniManager.cancelTrialJobByUser(req.params.id).then(() => {
                res.send();
            }).catch((err: Error) => {
                this.handle_error(err, res);
            });
        });
    }

    private getMetricData(router: Router): void {
        router.get('/metric-data/:job_id', async (req: Request, res: Response) => {
            this.nniManager.getMetricData(req.params.job_id, req.query.type).then((metricsData: MetricDataRecord[]) => {
                res.send(metricsData);
            }).catch((err: Error) => {
                this.handle_error(err, res);
            });
        });
    }

    private startTensorBoard(router: Router): void {
        router.post('/tensorboard', async (req: Request, res: Response) => {
            const jobIds: string[] = req.query.job_ids.split(',');
            const tensorboardCmd: string | undefined = req.query.tensorboard_cmd;
            this.tb.startTensorBoard(jobIds, tensorboardCmd).then((endPoint: string) => {
                res.send({endPoint: endPoint});
            }).catch((err: Error) => {
                this.handle_error(err, res);
            });
        });
    }

    private stopTensorBoard(router: Router): void {
        router.delete('/tensorboard', async (req: Request, res: Response) => {
            const endPoint: string = req.query.endpoint;
            this.tb.stopTensorBoard(endPoint).then(() => {
                res.send();
            }).catch((err: Error) => {
                this.handle_error(err, res);
            });
        });
    }

    private getExample(router: Router): void {
        // tslint:disable-next-line:no-empty
        router.get('/example', async (req: Request, res: Response) => {
        });
    }

    private getTriedParameters(router: Router): void {
        // tslint:disable-next-line:no-empty
        router.get('/tried-parameters', async (req: Request, res: Response) => {
        });
    }

    private setErrorPathForFailedJob(jobInfo: TrialJobInfo): TrialJobInfo {
        if (jobInfo === undefined || jobInfo.status !== 'FAILED' || jobInfo.logPath === undefined) {
            return jobInfo;
        }
        jobInfo.stderrPath = path.join(jobInfo.logPath, '.nni', 'stderr');

        return jobInfo;
    }
}

export function createRestHandler(rs: RestServer): Router {
    const handler: NNIRestHandler = new NNIRestHandler(rs);

    return handler.createRestHandler();
}