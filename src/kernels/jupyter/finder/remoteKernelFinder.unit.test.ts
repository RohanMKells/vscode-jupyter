// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Session } from '@jupyterlab/services';
import { assert } from 'chai';
import { anything, instance, mock, when } from 'ts-mockito';
import { getDisplayNameOrNameOfKernelConnection } from '../../helpers';
import { Disposable, EventEmitter, Memento, Uri } from 'vscode';
import { CryptoUtils } from '../../../platform/common/crypto';
import { noop } from '../../../test/core';
import {
    IJupyterConnection,
    IJupyterKernelSpec,
    IKernelProvider,
    KernelConnectionMetadata,
    LiveRemoteKernelConnectionMetadata,
    RemoteKernelSpecConnectionMetadata
} from '../../types';
import { JupyterSessionManager } from '../session/jupyterSessionManager';
import { JupyterSessionManagerFactory } from '../session/jupyterSessionManagerFactory';
import { ActiveKernelIdList } from '../connection/preferredRemoteKernelIdProvider';
import { IJupyterKernel, IJupyterRemoteCachedKernelValidator, IJupyterSessionManager } from '../types';
import { KernelFinder } from '../../kernelFinder';
import { NotebookProvider } from '../launcher/notebookProvider';
import { PythonExtensionChecker } from '../../../platform/api/pythonApi';
import { IFileSystemNode } from '../../../platform/common/platform/types.node';
import { JupyterServerUriStorage } from '../connection/serverUriStorage';
import { FileSystem } from '../../../platform/common/platform/fileSystem.node';
import { IApplicationEnvironment } from '../../../platform/common/application/types';
import { RemoteKernelSpecsCacheKey } from '../../common/commonFinder';
import { IExtensions } from '../../../platform/common/types';
import { createEventHandler, TestEventHandler } from '../../../test/common';
import { RemoteKernelFinder } from './remoteKernelFinder';

suite(`Remote Kernel Finder`, () => {
    let disposables: Disposable[] = [];
    let remoteKernelFinder: RemoteKernelFinder;
    let kernelFinder: KernelFinder;
    let fs: IFileSystemNode;
    let memento: Memento;
    let jupyterSessionManager: IJupyterSessionManager;
    const dummyEvent = new EventEmitter<number>();
    let cachedRemoteKernelValidator: IJupyterRemoteCachedKernelValidator;
    let kernelsChanged: TestEventHandler<void>;
    const connInfo: IJupyterConnection = {
        url: 'http://foobar',
        type: 'jupyter',
        localLaunch: false,
        baseUrl: 'http://foobar',
        displayName: 'foobar connection',
        disconnected: dummyEvent.event,
        token: '',
        hostName: 'foobar',
        rootDirectory: Uri.file('.'),
        dispose: noop
    };
    const defaultPython3Name = 'python3';
    const python3spec: IJupyterKernelSpec = {
        display_name: 'Python 3 on Disk',
        name: defaultPython3Name,
        argv: ['/usr/bin/python3'],
        language: 'python',
        executable: 'specFilePath'
    };
    const python2spec: IJupyterKernelSpec = {
        display_name: 'Python 2 on Disk',
        name: 'python2',
        argv: ['/usr/bin/python'],
        language: 'python',
        executable: 'specFilePath'
    };
    const juliaSpec: IJupyterKernelSpec = {
        display_name: 'Julia on Disk',
        name: 'julia',
        argv: ['/usr/bin/julia'],
        language: 'julia',
        executable: 'specFilePath'
    };
    const interpreterSpec: IJupyterKernelSpec = {
        display_name: 'Conda interpreter kernel',
        name: defaultPython3Name,
        argv: ['python'],
        language: 'python',
        executable: 'specFilePath'
    };
    const python3Kernels: IJupyterKernel[] = ['1', '2', '3'].map((id) => {
        return {
            name: python3spec.display_name,
            lastActivityTime: new Date(),
            numberOfConnections: 1,
            id
        };
    });
    const python3Sessions: Session.IModel[] = ['S1', 'S2', 'S3'].map((sid, i) => {
        return {
            id: sid,
            name: sid,
            path: '.',
            type: '',
            kernel: {
                id: python3Kernels[i].id!,
                name: python3Kernels[i].name,
                model: {}
            }
        };
    });

    setup(() => {
        memento = mock<Memento>();
        when(memento.get(anything(), anything())).thenCall((key: string, defaultValue: unknown) => {
            if (key === ActiveKernelIdList) {
                return [];
            }
            return defaultValue;
        });
        const crypto = mock(CryptoUtils);
        when(crypto.createHash(anything(), anything())).thenCall((d, _c) => {
            return Promise.resolve(d.toLowerCase());
        });
        jupyterSessionManager = mock(JupyterSessionManager);
        const jupyterSessionManagerFactory = mock(JupyterSessionManagerFactory);
        when(jupyterSessionManagerFactory.create(anything())).thenResolve(instance(jupyterSessionManager));
        const extensionChecker = mock(PythonExtensionChecker);
        when(extensionChecker.isPythonExtensionInstalled).thenReturn(true);
        const notebookProvider = mock(NotebookProvider);
        when(notebookProvider.connect(anything())).thenResolve(connInfo);
        fs = mock(FileSystem);
        when(fs.delete(anything())).thenResolve();
        when(fs.exists(anything())).thenResolve(true);
        const serverUriStorage = mock(JupyterServerUriStorage);
        const serverEntry = {
            uri: connInfo.baseUrl,
            time: Date.now(),
            serverId: connInfo.baseUrl,
            isValidated: true
        };
        when(serverUriStorage.getUri()).thenResolve(serverEntry);
        when(serverUriStorage.getRemoteUri()).thenResolve(serverEntry);
        when(serverUriStorage.isLocalLaunch).thenReturn(false);
        const onDidChangeEvent = new EventEmitter<void>();
        disposables.push(onDidChangeEvent);
        when(serverUriStorage.onDidChangeConnectionType).thenReturn(onDidChangeEvent.event);
        cachedRemoteKernelValidator = mock<IJupyterRemoteCachedKernelValidator>();
        when(cachedRemoteKernelValidator.isValid(anything())).thenResolve(true);
        const env = mock<IApplicationEnvironment>();
        when(env.extensionVersion).thenReturn('');
        const kernelProvider = mock<IKernelProvider>();
        const extensions = mock<IExtensions>();
        kernelFinder = new KernelFinder(disposables);
        kernelsChanged = createEventHandler(kernelFinder, 'onDidChangeKernels');
        disposables.push(kernelsChanged);

        remoteKernelFinder = new RemoteKernelFinder(
            'currentremote',
            'Local Kernels',
            RemoteKernelSpecsCacheKey,
            instance(jupyterSessionManagerFactory),
            instance(extensionChecker),
            instance(notebookProvider),
            instance(memento),
            instance(env),
            instance(cachedRemoteKernelValidator),
            kernelFinder,
            instance(kernelProvider),
            instance(extensions),
            serverEntry
        );
        remoteKernelFinder.activate().then(noop, noop);
    });
    teardown(() => {
        disposables.forEach((d) => d.dispose());
    });
    test('Kernels found', async () => {
        when(jupyterSessionManager.getRunningKernels()).thenResolve([]);
        when(jupyterSessionManager.getRunningSessions()).thenResolve([]);
        when(jupyterSessionManager.getKernelSpecs()).thenResolve([
            python3spec,
            python2spec,
            juliaSpec,
            interpreterSpec
        ]);
        const kernels = await remoteKernelFinder.listKernelsFromConnection(connInfo);
        assert.equal(kernels.length, 4, 'Not enough kernels returned');
        assert.equal(
            getDisplayNameOrNameOfKernelConnection(kernels[0]),
            'Python 3 on Disk',
            'Did not find correct python kernel'
        );
        assert.equal(
            getDisplayNameOrNameOfKernelConnection(kernels[1]),
            'Python 2 on Disk',
            'Did not find correct python 2 kernel'
        );
        assert.equal(
            getDisplayNameOrNameOfKernelConnection(kernels[2]),
            'Julia on Disk',
            'Did not find correct julia kernel'
        );
    });
    test('Live sessions', async () => {
        when(jupyterSessionManager.getRunningKernels()).thenResolve(python3Kernels);
        when(jupyterSessionManager.getRunningSessions()).thenResolve(python3Sessions);
        when(jupyterSessionManager.getKernelSpecs()).thenResolve([
            python3spec,
            python2spec,
            juliaSpec,
            interpreterSpec
        ]);
        const kernels = await remoteKernelFinder.listKernelsFromConnection(connInfo);
        const liveKernels = kernels.filter((k) => k.kind === 'connectToLiveRemoteKernel');
        assert.equal(liveKernels.length, 3, 'Live kernels not found');
    });
    test('Do not return cached remote kernelspecs or live kernels', async () => {
        const liveRemoteKernel = LiveRemoteKernelConnectionMetadata.create({
            baseUrl: 'baseUrl1',
            id: '1',
            kernelModel: {
                lastActivityTime: new Date(),
                model: {
                    id: '1',
                    name: '',
                    path: '',
                    type: '',
                    kernel: {
                        id: '1',
                        name: ''
                    }
                },
                name: '',
                numberOfConnections: 0
            },
            serverId: 'serverId1'
        });
        const cachedKernels = [
            RemoteKernelSpecConnectionMetadata.create({
                baseUrl: 'baseUrl1',
                id: '2',
                kernelSpec: {
                    argv: [],
                    display_name: '',
                    name: '',
                    executable: ''
                },
                serverId: 'serverId1'
            }).toJSON(),
            liveRemoteKernel.toJSON()
        ] as KernelConnectionMetadata[];
        when(cachedRemoteKernelValidator.isValid(anything())).thenResolve(false);
        when(
            memento.get<{ kernels: KernelConnectionMetadata[]; extensionVersion: string }>(
                RemoteKernelSpecsCacheKey,
                anything()
            )
        ).thenReturn({ kernels: cachedKernels, extensionVersion: '' });
        when(jupyterSessionManager.getRunningKernels()).thenResolve([]);
        when(jupyterSessionManager.getRunningSessions()).thenResolve([]);
        when(jupyterSessionManager.getKernelSpecs()).thenResolve([]);
        await remoteKernelFinder.loadCache();
        await kernelsChanged.assertFiredAtLeast(1, 100).catch(noop);

        assert.lengthOf(kernelFinder.kernels, 0);
    });
    test('Return cached remote live kernel if used', async () => {
        const liveRemoteKernel = LiveRemoteKernelConnectionMetadata.create({
            baseUrl: 'baseUrl1',
            id: '1',
            kernelModel: {
                lastActivityTime: new Date(),
                model: {
                    id: '1',
                    name: '',
                    path: '',
                    type: '',
                    kernel: {
                        id: '1',
                        name: ''
                    }
                },
                name: '',
                numberOfConnections: 0
            },
            serverId: 'serverId1'
        });
        const cachedKernels = [
            RemoteKernelSpecConnectionMetadata.create({
                baseUrl: 'baseUrl1',
                id: '2',
                kernelSpec: {
                    argv: [],
                    display_name: '',
                    name: '',
                    executable: ''
                },
                serverId: 'serverId1'
            }).toJSON(),
            liveRemoteKernel.toJSON()
        ] as KernelConnectionMetadata[];
        when(cachedRemoteKernelValidator.isValid(anything())).thenCall(async (k) => liveRemoteKernel.id === k.id);
        when(
            memento.get<{ kernels: KernelConnectionMetadata[]; extensionVersion: string }>(
                RemoteKernelSpecsCacheKey,
                anything()
            )
        ).thenReturn({ kernels: cachedKernels, extensionVersion: '' });
        when(jupyterSessionManager.getRunningKernels()).thenResolve([]);
        when(jupyterSessionManager.getRunningSessions()).thenResolve([]);
        when(jupyterSessionManager.getKernelSpecs()).thenResolve([]);
        await remoteKernelFinder.loadCache();

        assert.lengthOf(kernelFinder.kernels, 1);
        assert.deepEqual(kernelFinder.kernels, [liveRemoteKernel]);
    });
});
