/* eslint-disable no-continue */
import _ from 'underscore';
import * as Logger from './Logger';
import cache, {TASK} from './OnyxCache';
import * as PerformanceUtils from './PerformanceUtils';
import Storage from './storage';
import utils from './utils';
import DevTools from './DevTools';
import type {
    Collection,
    CollectionKey,
    CollectionKeyBase,
    ConnectOptions,
    InitOptions,
    KeyValueMapping,
    Mapping,
    OnyxInputKeyValueMapping,
    OnyxCollection,
    MixedOperationsQueue,
    OnyxKey,
    OnyxMergeCollectionInput,
    OnyxMergeInput,
    OnyxMultiSetInput,
    OnyxSetInput,
    OnyxUpdate,
    OnyxValue,
    OnyxInput,
    OnyxMethodMap,
} from './types';
import OnyxUtils from './OnyxUtils';
import logMessages from './logMessages';
import type {Connection} from './OnyxConnectionManager';
import connectionManager from './OnyxConnectionManager';
import * as GlobalSettings from './GlobalSettings';
import decorateWithMetrics from './metrics';

/** Initialize the store with actions and listening for storage events */
function init({
    keys = {},
    initialKeyStates = {},
    evictableKeys = [],
    maxCachedKeysCount = 1000,
    shouldSyncMultipleInstances = !!global.localStorage,
    debugSetState = false,
    enablePerformanceMetrics = false,
    skippableCollectionMemberIDs = [],
    fullyMergedSnapshotKeys = [],
}: InitOptions): void {
    if (enablePerformanceMetrics) {
        GlobalSettings.setPerformanceMetricsEnabled(true);
        applyDecorators();
    }

    Storage.init();

    OnyxUtils.setSkippableCollectionMemberIDs(new Set(skippableCollectionMemberIDs));

    if (shouldSyncMultipleInstances) {
        Storage.keepInstancesSync?.((key, value) => {
            const prevValue = cache.get(key, false) as OnyxValue<typeof key>;
            cache.set(key, value);
            OnyxUtils.keyChanged(key, value as OnyxValue<typeof key>, prevValue);
        });
    }

    if (debugSetState) {
        PerformanceUtils.setShouldDebugSetState(true);
    }

    if (maxCachedKeysCount > 0) {
        cache.setRecentKeysLimit(maxCachedKeysCount);
    }

    OnyxUtils.initStoreValues(keys, initialKeyStates, evictableKeys, fullyMergedSnapshotKeys);

    // Initialize all of our keys with data provided then give green light to any pending connections
    Promise.all([cache.addEvictableKeysToRecentlyAccessedList(OnyxUtils.isCollectionKey, OnyxUtils.getAllKeys), OnyxUtils.initializeWithDefaultKeyStates()]).then(
        OnyxUtils.getDeferredInitTask().resolve,
    );
}

/**
 * Connects to an Onyx key given the options passed and listens to its changes.
 *
 * @example
 * ```ts
 * const connection = Onyx.connect({
 *     key: ONYXKEYS.SESSION,
 *     callback: onSessionChange,
 * });
 * ```
 *
 * @param connectOptions The options object that will define the behavior of the connection.
 * @param connectOptions.key The Onyx key to subscribe to.
 * @param connectOptions.callback A function that will be called when the Onyx data we are subscribed changes.
 * @param connectOptions.waitForCollectionCallback If set to `true`, it will return the entire collection to the callback as a single object.
 * @param connectOptions.withOnyxInstance The `withOnyx` class instance to be internally passed. **Only used inside `withOnyx()` HOC.**
 * @param connectOptions.statePropertyName The name of the component's prop that is connected to the Onyx key. **Only used inside `withOnyx()` HOC.**
 * @param connectOptions.displayName The component's display name. **Only used inside `withOnyx()` HOC.**
 * @param connectOptions.selector This will be used to subscribe to a subset of an Onyx key's data. **Only used inside `useOnyx()` hook or `withOnyx()` HOC.**
 *        Using this setting on `useOnyx()` or `withOnyx()` can have very positive performance benefits because the component will only re-render
 *        when the subset of data changes. Otherwise, any change of data on any property would normally
 *        cause the component to re-render (and that can be expensive from a performance standpoint).
 * @returns The connection object to use when calling `Onyx.disconnect()`.
 */
function connect<TKey extends OnyxKey>(connectOptions: ConnectOptions<TKey>): Connection {
    return connectionManager.connect(connectOptions);
}

/**
 * Disconnects and removes the listener from the Onyx key.
 *
 * @example
 * ```ts
 * const connection = Onyx.connect({
 *     key: ONYXKEYS.SESSION,
 *     callback: onSessionChange,
 * });
 *
 * Onyx.disconnect(connection);
 * ```
 *
 * @param connection Connection object returned by calling `Onyx.connect()`.
 */
function disconnect(connection: Connection): void {
    connectionManager.disconnect(connection);
}

/**
 * Write a value to our store with the given key
 *
 * @param key ONYXKEY to set
 * @param value value to store
 */
function set<TKey extends OnyxKey>(key: TKey, value: OnyxSetInput<TKey>): Promise<void> {
    // When we use Onyx.set to set a key we want to clear the current delta changes from Onyx.merge that were queued
    // before the value was set. If Onyx.merge is currently reading the old value from storage, it will then not apply the changes.
    if (OnyxUtils.hasPendingMergeForKey(key)) {
        delete OnyxUtils.getMergeQueue()[key];
    }

    const skippableCollectionMemberIDs = OnyxUtils.getSkippableCollectionMemberIDs();
    if (skippableCollectionMemberIDs.size) {
        try {
            const [, collectionMemberID] = OnyxUtils.splitCollectionMemberKey(key);
            if (skippableCollectionMemberIDs.has(collectionMemberID)) {
                // The key is a skippable one, so we set the new value to null.
                // eslint-disable-next-line no-param-reassign
                value = null;
            }
        } catch (e) {
            // The key is not a collection one or something went wrong during split, so we proceed with the function's logic.
        }
    }

    // Onyx.set will ignore `undefined` values as inputs, therefore we can return early.
    if (value === undefined) {
        return Promise.resolve();
    }

    const existingValue = cache.get(key, false);
    // If the existing value as well as the new value are null, we can return early.
    if (existingValue === undefined && value === null) {
        return Promise.resolve();
    }

    // Check if the value is compatible with the existing value in the storage
    const {isCompatible, existingValueType, newValueType} = utils.checkCompatibilityWithExistingValue(value, existingValue);
    if (!isCompatible) {
        Logger.logAlert(logMessages.incompatibleUpdateAlert(key, 'set', existingValueType, newValueType));
        return Promise.resolve();
    }

    // If the value is null, we remove the key from storage
    const {value: valueAfterRemoving, wasRemoved} = OnyxUtils.removeNullValues(key, value);

    const logSetCall = (hasChanged = true) => {
        // Logging properties only since values could be sensitive things we don't want to log
        Logger.logInfo(`set called for key: ${key}${_.isObject(value) ? ` properties: ${_.keys(value).join(',')}` : ''} hasChanged: ${hasChanged}`);
    };

    // Calling "OnyxUtils.removeNullValues" removes the key from storage and cache and updates the subscriber.
    // Therefore, we don't need to further broadcast and update the value so we can return early.
    if (wasRemoved) {
        logSetCall();
        return Promise.resolve();
    }

    const valueWithoutNullValues = valueAfterRemoving as OnyxValue<TKey>;
    const hasChanged = cache.hasValueChanged(key, valueWithoutNullValues);

    logSetCall(hasChanged);

    // This approach prioritizes fast UI changes without waiting for data to be stored in device storage.
    const updatePromise = OnyxUtils.broadcastUpdate(key, valueWithoutNullValues, hasChanged);

    // If the value has not changed or the key got removed, calling Storage.setItem() would be redundant and a waste of performance, so return early instead.
    if (!hasChanged) {
        return updatePromise;
    }

    return Storage.setItem(key, valueWithoutNullValues)
        .catch((error) => OnyxUtils.evictStorageAndRetry(error, set, key, valueWithoutNullValues))
        .then(() => {
            OnyxUtils.sendActionToDevTools(OnyxUtils.METHOD.SET, key, valueWithoutNullValues);
            return updatePromise;
        });
}

/**
 * Sets multiple keys and values
 *
 * @example Onyx.multiSet({'key1': 'a', 'key2': 'b'});
 *
 * @param data object keyed by ONYXKEYS and the values to set
 */
function multiSet(data: OnyxMultiSetInput): Promise<void> {
    let newData = data;

    const skippableCollectionMemberIDs = OnyxUtils.getSkippableCollectionMemberIDs();
    if (skippableCollectionMemberIDs.size) {
        newData = Object.keys(newData).reduce((result: OnyxMultiSetInput, key) => {
            try {
                const [, collectionMemberID] = OnyxUtils.splitCollectionMemberKey(key);
                // If the collection member key is a skippable one we set its value to null.
                // eslint-disable-next-line no-param-reassign
                result[key] = !skippableCollectionMemberIDs.has(collectionMemberID) ? newData[key] : null;
            } catch {
                // The key is not a collection one or something went wrong during split, so we assign the data to result anyway.
                // eslint-disable-next-line no-param-reassign
                result[key] = newData[key];
            }

            return result;
        }, {});
    }

    const keyValuePairsToSet = OnyxUtils.prepareKeyValuePairsForStorage(newData, true);

    const updatePromises = keyValuePairsToSet.map(([key, value]) => {
        const prevValue = cache.get(key, false);
        // When we use multiSet to set a key we want to clear the current delta changes from Onyx.merge that were queued
        // before the value was set. If Onyx.merge is currently reading the old value from storage, it will then not apply the changes.
        if (OnyxUtils.hasPendingMergeForKey(key)) {
            delete OnyxUtils.getMergeQueue()[key];
        }

        // Update cache and optimistically inform subscribers on the next tick
        cache.set(key, value);
        return OnyxUtils.scheduleSubscriberUpdate(key, value, prevValue);
    });

    return Storage.multiSet(keyValuePairsToSet)
        .catch((error) => OnyxUtils.evictStorageAndRetry(error, multiSet, newData))
        .then(() => {
            OnyxUtils.sendActionToDevTools(OnyxUtils.METHOD.MULTI_SET, undefined, newData);
            return Promise.all(updatePromises);
        })
        .then(() => undefined);
}

/**
 * Merge a new value into an existing value at a key.
 *
 * The types of values that can be merged are `Object` and `Array`. To set another type of value use `Onyx.set()`.
 * Values of type `Object` get merged with the old value, whilst for `Array`'s we simply replace the current value with the new one.
 *
 * Calls to `Onyx.merge()` are batched so that any calls performed in a single tick will stack in a queue and get
 * applied in the order they were called. Note: `Onyx.set()` calls do not work this way so use caution when mixing
 * `Onyx.merge()` and `Onyx.set()`.
 *
 * @example
 * Onyx.merge(ONYXKEYS.EMPLOYEE_LIST, ['Joe']); // -> ['Joe']
 * Onyx.merge(ONYXKEYS.EMPLOYEE_LIST, ['Jack']); // -> ['Joe', 'Jack']
 * Onyx.merge(ONYXKEYS.POLICY, {id: 1}); // -> {id: 1}
 * Onyx.merge(ONYXKEYS.POLICY, {name: 'My Workspace'}); // -> {id: 1, name: 'My Workspace'}
 */
function merge<TKey extends OnyxKey>(key: TKey, changes: OnyxMergeInput<TKey>): Promise<void> {
    const skippableCollectionMemberIDs = OnyxUtils.getSkippableCollectionMemberIDs();
    if (skippableCollectionMemberIDs.size) {
        try {
            const [, collectionMemberID] = OnyxUtils.splitCollectionMemberKey(key);
            if (skippableCollectionMemberIDs.has(collectionMemberID)) {
                // The key is a skippable one, so we set the new changes to undefined.
                // eslint-disable-next-line no-param-reassign
                changes = undefined;
            }
        } catch (e) {
            // The key is not a collection one or something went wrong during split, so we proceed with the function's logic.
        }
    }

    const mergeQueue = OnyxUtils.getMergeQueue();
    const mergeQueuePromise = OnyxUtils.getMergeQueuePromise();

    // Top-level undefined values are ignored
    // Therefore, we need to prevent adding them to the merge queue
    if (changes === undefined) {
        return mergeQueue[key] ? mergeQueuePromise[key] : Promise.resolve();
    }

    // Merge attempts are batched together. The delta should be applied after a single call to get() to prevent a race condition.
    // Using the initial value from storage in subsequent merge attempts will lead to an incorrect final merged value.
    if (mergeQueue[key]) {
        mergeQueue[key].push(changes);
        return mergeQueuePromise[key];
    }
    mergeQueue[key] = [changes];

    mergeQueuePromise[key] = OnyxUtils.get(key).then((existingValue) => {
        // Calls to Onyx.set after a merge will terminate the current merge process and clear the merge queue
        if (mergeQueue[key] == null) {
            return Promise.resolve();
        }

        try {
            // We first only merge the changes, so we can provide these to the native implementation (SQLite uses only delta changes in "JSON_PATCH" to merge)
            // We don't want to remove null values from the "batchedDeltaChanges", because SQLite uses them to remove keys from storage natively.
            const validChanges = mergeQueue[key].filter((change) => {
                const {isCompatible, existingValueType, newValueType} = utils.checkCompatibilityWithExistingValue(change, existingValue);
                if (!isCompatible) {
                    Logger.logAlert(logMessages.incompatibleUpdateAlert(key, 'merge', existingValueType, newValueType));
                }
                return isCompatible;
            }) as Array<OnyxInput<TKey>>;

            if (!validChanges.length) {
                return Promise.resolve();
            }
            const batchedDeltaChanges = OnyxUtils.applyMerge(undefined, validChanges, false);

            // Case (1): When there is no existing value in storage, we want to set the value instead of merge it.
            // Case (2): The presence of a top-level `null` in the merge queue instructs us to drop the whole existing value.
            // In this case, we can't simply merge the batched changes with the existing value, because then the null in the merge queue would have no effect
            const shouldSetValue = !existingValue || mergeQueue[key].includes(null);

            // Clean up the write queue, so we don't apply these changes again
            delete mergeQueue[key];
            delete mergeQueuePromise[key];

            const logMergeCall = (hasChanged = true) => {
                // Logging properties only since values could be sensitive things we don't want to log
                Logger.logInfo(`merge called for key: ${key}${_.isObject(batchedDeltaChanges) ? ` properties: ${_.keys(batchedDeltaChanges).join(',')}` : ''} hasChanged: ${hasChanged}`);
            };

            // If the batched changes equal null, we want to remove the key from storage, to reduce storage size
            const {wasRemoved} = OnyxUtils.removeNullValues(key, batchedDeltaChanges);

            // Calling "OnyxUtils.removeNullValues" removes the key from storage and cache and updates the subscriber.
            // Therefore, we don't need to further broadcast and update the value so we can return early.
            if (wasRemoved) {
                logMergeCall();
                return Promise.resolve();
            }

            // For providers that can't handle delta changes, we need to merge the batched changes with the existing value beforehand.
            // The "preMergedValue" will be directly "set" in storage instead of being merged
            // Therefore we merge the batched changes with the existing value to get the final merged value that will be stored.
            // We can remove null values from the "preMergedValue", because "null" implicates that the user wants to remove a value from storage.
            const preMergedValue = OnyxUtils.applyMerge(shouldSetValue ? undefined : existingValue, [batchedDeltaChanges], true);

            // In cache, we don't want to remove the key if it's null to improve performance and speed up the next merge.
            const hasChanged = cache.hasValueChanged(key, preMergedValue);

            logMergeCall(hasChanged);

            // This approach prioritizes fast UI changes without waiting for data to be stored in device storage.
            const updatePromise = OnyxUtils.broadcastUpdate(key, preMergedValue as OnyxValue<TKey>, hasChanged);

            // If the value has not changed, calling Storage.setItem() would be redundant and a waste of performance, so return early instead.
            if (!hasChanged) {
                return updatePromise;
            }

            return Storage.mergeItem(key, batchedDeltaChanges as OnyxValue<TKey>, preMergedValue as OnyxValue<TKey>, shouldSetValue).then(() => {
                OnyxUtils.sendActionToDevTools(OnyxUtils.METHOD.MERGE, key, changes, preMergedValue);
                return updatePromise;
            });
        } catch (error) {
            Logger.logAlert(`An error occurred while applying merge for key: ${key}, Error: ${error}`);
            return Promise.resolve();
        }
    });

    return mergeQueuePromise[key];
}

/**
 * Merges a collection based on their keys
 *
 * @example
 *
 * Onyx.mergeCollection(ONYXKEYS.COLLECTION.REPORT, {
 *     [`${ONYXKEYS.COLLECTION.REPORT}1`]: report1,
 *     [`${ONYXKEYS.COLLECTION.REPORT}2`]: report2,
 * });
 *
 * @param collectionKey e.g. `ONYXKEYS.COLLECTION.REPORT`
 * @param collection Object collection keyed by individual collection member keys and values
 */
function mergeCollection<TKey extends CollectionKeyBase, TMap>(collectionKey: TKey, collection: OnyxMergeCollectionInput<TKey, TMap>): Promise<void> {
    if (!OnyxUtils.isValidNonEmptyCollectionForMerge(collection)) {
        Logger.logInfo('mergeCollection() called with invalid or empty value. Skipping this update.');
        return Promise.resolve();
    }

    let resultCollection: OnyxInputKeyValueMapping = collection;
    let resultCollectionKeys = Object.keys(resultCollection);

    // Confirm all the collection keys belong to the same parent
    if (!OnyxUtils.doAllCollectionItemsBelongToSameParent(collectionKey, resultCollectionKeys)) {
        return Promise.resolve();
    }

    const skippableCollectionMemberIDs = OnyxUtils.getSkippableCollectionMemberIDs();
    if (skippableCollectionMemberIDs.size) {
        resultCollection = resultCollectionKeys.reduce((result: OnyxInputKeyValueMapping, key) => {
            try {
                const [, collectionMemberID] = OnyxUtils.splitCollectionMemberKey(key, collectionKey);
                // If the collection member key is a skippable one we set its value to null.
                // eslint-disable-next-line no-param-reassign
                result[key] = !skippableCollectionMemberIDs.has(collectionMemberID) ? resultCollection[key] : null;
            } catch {
                // Something went wrong during split, so we assign the data to result anyway.
                // eslint-disable-next-line no-param-reassign
                result[key] = resultCollection[key];
            }

            return result;
        }, {});
    }
    resultCollectionKeys = Object.keys(resultCollection);

    return OnyxUtils.getAllKeys()
        .then((persistedKeys) => {
            // Split to keys that exist in storage and keys that don't
            const keys = resultCollectionKeys.filter((key) => {
                if (resultCollection[key] === null) {
                    OnyxUtils.remove(key);
                    return false;
                }
                return true;
            });

            const existingKeys = keys.filter((key) => persistedKeys.has(key));

            const cachedCollectionForExistingKeys = OnyxUtils.getCachedCollection(collectionKey, existingKeys);

            const existingKeyCollection = existingKeys.reduce((obj: OnyxInputKeyValueMapping, key) => {
                const {isCompatible, existingValueType, newValueType} = utils.checkCompatibilityWithExistingValue(resultCollection[key], cachedCollectionForExistingKeys[key]);
                if (!isCompatible) {
                    Logger.logAlert(logMessages.incompatibleUpdateAlert(key, 'mergeCollection', existingValueType, newValueType));
                    return obj;
                }
                // eslint-disable-next-line no-param-reassign
                obj[key] = resultCollection[key];
                return obj;
            }, {}) as Record<OnyxKey, OnyxInput<TKey>>;

            const newCollection: Record<OnyxKey, OnyxInput<TKey>> = {};
            keys.forEach((key) => {
                if (persistedKeys.has(key)) {
                    return;
                }
                newCollection[key] = resultCollection[key];
            });

            // When (multi-)merging the values with the existing values in storage,
            // we don't want to remove nested null values from the data that we pass to the storage layer,
            // because the storage layer uses them to remove nested keys from storage natively.
            const keyValuePairsForExistingCollection = OnyxUtils.prepareKeyValuePairsForStorage(existingKeyCollection, false);

            // We can safely remove nested null values when using (multi-)set,
            // because we will simply overwrite the existing values in storage.
            const keyValuePairsForNewCollection = OnyxUtils.prepareKeyValuePairsForStorage(newCollection, true);

            const promises = [];

            // We need to get the previously existing values so we can compare the new ones
            // against them, to avoid unnecessary subscriber updates.
            const previousCollectionPromise = Promise.all(existingKeys.map((key) => OnyxUtils.get(key).then((value) => [key, value]))).then(Object.fromEntries);

            // New keys will be added via multiSet while existing keys will be updated using multiMerge
            // This is because setting a key that doesn't exist yet with multiMerge will throw errors
            if (keyValuePairsForExistingCollection.length > 0) {
                promises.push(Storage.multiMerge(keyValuePairsForExistingCollection));
            }

            if (keyValuePairsForNewCollection.length > 0) {
                promises.push(Storage.multiSet(keyValuePairsForNewCollection));
            }

            // finalMergedCollection contains all the keys that were merged, without the keys of incompatible updates
            const finalMergedCollection = {...existingKeyCollection, ...newCollection};

            // Prefill cache if necessary by calling get() on any existing keys and then merge original data to cache
            // and update all subscribers
            const promiseUpdate = previousCollectionPromise.then((previousCollection) => {
                cache.merge(finalMergedCollection);
                return OnyxUtils.scheduleNotifyCollectionSubscribers(collectionKey, finalMergedCollection, previousCollection);
            });

            return Promise.all(promises)
                .catch((error) => OnyxUtils.evictStorageAndRetry(error, mergeCollection, collectionKey, resultCollection))
                .then(() => {
                    OnyxUtils.sendActionToDevTools(OnyxUtils.METHOD.MERGE_COLLECTION, undefined, resultCollection);
                    return promiseUpdate;
                });
        })
        .then(() => undefined);
}

/**
 * Clear out all the data in the store
 *
 * Note that calling Onyx.clear() and then Onyx.set() on a key with a default
 * key state may store an unexpected value in Storage.
 *
 * E.g.
 * Onyx.clear();
 * Onyx.set(ONYXKEYS.DEFAULT_KEY, 'default');
 * Storage.getItem(ONYXKEYS.DEFAULT_KEY)
 *     .then((storedValue) => console.log(storedValue));
 * null is logged instead of the expected 'default'
 *
 * Onyx.set() might call Storage.setItem() before Onyx.clear() calls
 * Storage.setItem(). Use Onyx.merge() instead if possible. Onyx.merge() calls
 * Onyx.get(key) before calling Storage.setItem() via Onyx.set().
 * Storage.setItem() from Onyx.clear() will have already finished and the merged
 * value will be saved to storage after the default value.
 *
 * @param keysToPreserve is a list of ONYXKEYS that should not be cleared with the rest of the data
 */
function clear(keysToPreserve: OnyxKey[] = []): Promise<void> {
    const defaultKeyStates = OnyxUtils.getDefaultKeyStates();
    const initialKeys = Object.keys(defaultKeyStates);

    const promise = OnyxUtils.getAllKeys()
        .then((cachedKeys) => {
            cache.clearNullishStorageKeys();

            const keysToBeClearedFromStorage: OnyxKey[] = [];
            const keyValuesToResetAsCollection: Record<OnyxKey, OnyxCollection<KeyValueMapping[OnyxKey]>> = {};
            const keyValuesToResetIndividually: KeyValueMapping = {};

            const allKeys = new Set([...cachedKeys, ...initialKeys]);

            // The only keys that should not be cleared are:
            // 1. Anything specifically passed in keysToPreserve (because some keys like language preferences, offline
            //      status, or activeClients need to remain in Onyx even when signed out)
            // 2. Any keys with a default state (because they need to remain in Onyx as their default, and setting them
            //      to null would cause unknown behavior)
            //   2.1 However, if a default key was explicitly set to null, we need to reset it to the default value
            allKeys.forEach((key) => {
                const isKeyToPreserve = keysToPreserve.includes(key);
                const isDefaultKey = key in defaultKeyStates;

                // If the key is being removed or reset to default:
                // 1. Update it in the cache
                // 2. Figure out whether it is a collection key or not,
                //      since collection key subscribers need to be updated differently
                if (!isKeyToPreserve) {
                    const oldValue = cache.get(key);
                    const newValue = defaultKeyStates[key] ?? null;
                    if (newValue !== oldValue) {
                        cache.set(key, newValue);

                        let collectionKey: string | undefined;
                        try {
                            collectionKey = OnyxUtils.getCollectionKey(key);
                        } catch (e) {
                            // If getCollectionKey() throws an error it means the key is not a collection key.
                            collectionKey = undefined;
                        }

                        if (collectionKey) {
                            if (!keyValuesToResetAsCollection[collectionKey]) {
                                keyValuesToResetAsCollection[collectionKey] = {};
                            }
                            keyValuesToResetAsCollection[collectionKey]![key] = newValue ?? undefined;
                        } else {
                            keyValuesToResetIndividually[key] = newValue ?? undefined;
                        }
                    }
                }

                if (isKeyToPreserve || isDefaultKey) {
                    return;
                }

                // If it isn't preserved and doesn't have a default, we'll remove it
                keysToBeClearedFromStorage.push(key);
            });

            const updatePromises: Array<Promise<void>> = [];

            // Notify the subscribers for each key/value group so they can receive the new values
            Object.entries(keyValuesToResetIndividually).forEach(([key, value]) => {
                updatePromises.push(OnyxUtils.scheduleSubscriberUpdate(key, value, cache.get(key, false)));
            });
            Object.entries(keyValuesToResetAsCollection).forEach(([key, value]) => {
                updatePromises.push(OnyxUtils.scheduleNotifyCollectionSubscribers(key, value));
            });

            const defaultKeyValuePairs = Object.entries(
                Object.keys(defaultKeyStates)
                    .filter((key) => !keysToPreserve.includes(key))
                    .reduce((obj: KeyValueMapping, key) => {
                        // eslint-disable-next-line no-param-reassign
                        obj[key] = defaultKeyStates[key];
                        return obj;
                    }, {}),
            );

            // Remove only the items that we want cleared from storage, and reset others to default
            keysToBeClearedFromStorage.forEach((key) => cache.drop(key));
            return Storage.removeItems(keysToBeClearedFromStorage)
                .then(() => connectionManager.refreshSessionID())
                .then(() => Storage.multiSet(defaultKeyValuePairs))
                .then(() => {
                    DevTools.clearState(keysToPreserve);
                    return Promise.all(updatePromises);
                });
        })
        .then(() => undefined);

    return cache.captureTask(TASK.CLEAR, promise) as Promise<void>;
}

/**
 * Insert API responses and lifecycle data into Onyx
 *
 * @param data An array of objects with update expressions
 * @returns resolves when all operations are complete
 */
function update(data: OnyxUpdate[]): Promise<void> {
    // First, validate the Onyx object is in the format we expect
    data.forEach(({onyxMethod, key, value}) => {
        if (!Object.values(OnyxUtils.METHOD).includes(onyxMethod)) {
            throw new Error(`Invalid onyxMethod ${onyxMethod} in Onyx update.`);
        }
        if (onyxMethod === OnyxUtils.METHOD.MULTI_SET) {
            // For multiset, we just expect the value to be an object
            if (typeof value !== 'object' || Array.isArray(value) || typeof value === 'function') {
                throw new Error('Invalid value provided in Onyx multiSet. Onyx multiSet value must be of type object.');
            }
        } else if (onyxMethod !== OnyxUtils.METHOD.CLEAR && typeof key !== 'string') {
            throw new Error(`Invalid ${typeof key} key provided in Onyx update. Onyx key must be of type string.`);
        }
    });

    // The queue of operations within a single `update` call in the format of <item key - list of operations updating the item>.
    // This allows us to batch the operations per item and merge them into one operation in the order they were requested.
    const updateQueue: Record<OnyxKey, Array<OnyxValue<OnyxKey>>> = {};
    const enqueueSetOperation = (key: OnyxKey, value: OnyxValue<OnyxKey>) => {
        // If a `set` operation is enqueued, we should clear the whole queue.
        // Since the `set` operation replaces the value entirely, there's no need to perform any previous operations.
        // To do this, we first put `null` in the queue, which removes the existing value, and then merge the new value.
        updateQueue[key] = [null, value];
    };
    const enqueueMergeOperation = (key: OnyxKey, value: OnyxValue<OnyxKey>) => {
        if (value === null) {
            // If we merge `null`, the value is removed and all the previous operations are discarded.
            updateQueue[key] = [null];
        } else if (!updateQueue[key]) {
            updateQueue[key] = [value];
        } else {
            updateQueue[key].push(value);
        }
    };

    const promises: Array<() => Promise<void>> = [];
    let clearPromise: Promise<void> = Promise.resolve();

    data.forEach(({onyxMethod, key, value}) => {
        const handlers: Record<OnyxMethodMap[keyof OnyxMethodMap], (k: typeof key, v: typeof value) => void> = {
            [OnyxUtils.METHOD.SET]: enqueueSetOperation,
            [OnyxUtils.METHOD.MERGE]: enqueueMergeOperation,
            [OnyxUtils.METHOD.MERGE_COLLECTION]: () => {
                const collection = value as Collection<CollectionKey, unknown, unknown>;
                if (!OnyxUtils.isValidNonEmptyCollectionForMerge(collection)) {
                    Logger.logInfo('mergeCollection enqueued within update() with invalid or empty value. Skipping this operation.');
                    return;
                }

                // Confirm all the collection keys belong to the same parent
                const collectionKeys = Object.keys(collection);
                if (OnyxUtils.doAllCollectionItemsBelongToSameParent(key, collectionKeys)) {
                    const mergedCollection: OnyxInputKeyValueMapping = collection;
                    collectionKeys.forEach((collectionKey) => enqueueMergeOperation(collectionKey, mergedCollection[collectionKey]));
                }
            },
            [OnyxUtils.METHOD.SET_COLLECTION]: (k, v) => promises.push(() => setCollection(k, v as Collection<CollectionKey, unknown, unknown>)),
            [OnyxUtils.METHOD.MULTI_SET]: (k, v) => Object.entries(v as Partial<OnyxInputKeyValueMapping>).forEach(([entryKey, entryValue]) => enqueueSetOperation(entryKey, entryValue)),
            [OnyxUtils.METHOD.CLEAR]: () => {
                clearPromise = clear();
            },
        };

        handlers[onyxMethod](key, value);
    });

    // Group all the collection-related keys and update each collection in a single `mergeCollection` call.
    // This is needed to prevent multiple `mergeCollection` calls for the same collection and `merge` calls for the individual items of the said collection.
    // This way, we ensure there is no race condition in the queued updates of the same key.
    OnyxUtils.getCollectionKeys().forEach((collectionKey) => {
        const collectionItemKeys = Object.keys(updateQueue).filter((key) => OnyxUtils.isKeyMatch(collectionKey, key));
        if (collectionItemKeys.length <= 1) {
            // If there are no items of this collection in the updateQueue, we should skip it.
            // If there is only one item, we should update it individually, therefore retain it in the updateQueue.
            return;
        }

        const batchedCollectionUpdates = collectionItemKeys.reduce(
            (queue: MixedOperationsQueue, key: string) => {
                const operations = updateQueue[key];

                // Remove the collection-related key from the updateQueue so that it won't be processed individually.
                delete updateQueue[key];

                const updatedValue = OnyxUtils.applyMerge(undefined, operations, false);
                if (operations[0] === null) {
                    // eslint-disable-next-line no-param-reassign
                    queue.set[key] = updatedValue;
                } else {
                    // eslint-disable-next-line no-param-reassign
                    queue.merge[key] = updatedValue;
                }
                return queue;
            },
            {
                merge: {},
                set: {},
            },
        );

        if (!utils.isEmptyObject(batchedCollectionUpdates.merge)) {
            promises.push(() => mergeCollection(collectionKey, batchedCollectionUpdates.merge as Collection<CollectionKey, unknown, unknown>));
        }
        if (!utils.isEmptyObject(batchedCollectionUpdates.set)) {
            promises.push(() => multiSet(batchedCollectionUpdates.set));
        }
    });

    Object.entries(updateQueue).forEach(([key, operations]) => {
        const batchedChanges = OnyxUtils.applyMerge(undefined, operations, false);

        if (operations[0] === null) {
            promises.push(() => set(key, batchedChanges));
        } else {
            promises.push(() => merge(key, batchedChanges));
        }
    });

    const snapshotPromises = OnyxUtils.updateSnapshots(data, merge);

    // We need to run the snapshot updates before the other updates so the snapshot data can be updated before the loading state in the snapshot
    const finalPromises = snapshotPromises.concat(promises);

    return clearPromise.then(() => Promise.all(finalPromises.map((p) => p()))).then(() => undefined);
}

/**
 * Sets a collection by replacing all existing collection members with new values.
 * Any existing collection members not included in the new data will be removed.
 *
 * @example
 * Onyx.setCollection(ONYXKEYS.COLLECTION.REPORT, {
 *     [`${ONYXKEYS.COLLECTION.REPORT}1`]: report1,
 *     [`${ONYXKEYS.COLLECTION.REPORT}2`]: report2,
 * });
 *
 * @param collectionKey e.g. `ONYXKEYS.COLLECTION.REPORT`
 * @param collection Object collection keyed by individual collection member keys and values
 */
function setCollection<TKey extends CollectionKeyBase, TMap>(collectionKey: TKey, collection: OnyxMergeCollectionInput<TKey, TMap>): Promise<void> {
    let resultCollection: OnyxInputKeyValueMapping = collection;
    let resultCollectionKeys = Object.keys(resultCollection);

    // Confirm all the collection keys belong to the same parent
    if (!OnyxUtils.doAllCollectionItemsBelongToSameParent(collectionKey, resultCollectionKeys)) {
        Logger.logAlert(`setCollection called with keys that do not belong to the same parent ${collectionKey}. Skipping this update.`);
        return Promise.resolve();
    }

    const skippableCollectionMemberIDs = OnyxUtils.getSkippableCollectionMemberIDs();
    if (skippableCollectionMemberIDs.size) {
        resultCollection = resultCollectionKeys.reduce((result: OnyxInputKeyValueMapping, key) => {
            try {
                const [, collectionMemberID] = OnyxUtils.splitCollectionMemberKey(key, collectionKey);
                // If the collection member key is a skippable one we set its value to null.
                // eslint-disable-next-line no-param-reassign
                result[key] = !skippableCollectionMemberIDs.has(collectionMemberID) ? resultCollection[key] : null;
            } catch {
                // Something went wrong during split, so we assign the data to result anyway.
                // eslint-disable-next-line no-param-reassign
                result[key] = resultCollection[key];
            }

            return result;
        }, {});
    }
    resultCollectionKeys = Object.keys(resultCollection);

    return OnyxUtils.getAllKeys().then((persistedKeys) => {
        const mutableCollection: OnyxInputKeyValueMapping = {...resultCollection};

        persistedKeys.forEach((key) => {
            if (!key.startsWith(collectionKey)) {
                return;
            }
            if (resultCollectionKeys.includes(key)) {
                return;
            }

            mutableCollection[key] = null;
        });

        const keyValuePairs = OnyxUtils.prepareKeyValuePairsForStorage(mutableCollection, true);
        const previousCollection = OnyxUtils.getCachedCollection(collectionKey);

        keyValuePairs.forEach(([key, value]) => cache.set(key, value));

        const updatePromise = OnyxUtils.scheduleNotifyCollectionSubscribers(collectionKey, mutableCollection, previousCollection);

        return Storage.multiSet(keyValuePairs)
            .catch((error) => OnyxUtils.evictStorageAndRetry(error, setCollection, collectionKey, collection))
            .then(() => {
                OnyxUtils.sendActionToDevTools(OnyxUtils.METHOD.SET_COLLECTION, undefined, mutableCollection);
                return updatePromise;
            });
    });
}

const Onyx = {
    METHOD: OnyxUtils.METHOD,
    connect,
    disconnect,
    set,
    multiSet,
    merge,
    mergeCollection,
    setCollection,
    update,
    clear,
    init,
    registerLogger: Logger.registerLogger,
};

function applyDecorators() {
    // We are reassigning the functions directly so that internal function calls are also decorated
    /* eslint-disable rulesdir/prefer-actions-set-data */
    // @ts-expect-error Reassign
    connect = decorateWithMetrics(connect, 'Onyx.connect');
    // @ts-expect-error Reassign
    set = decorateWithMetrics(set, 'Onyx.set');
    // @ts-expect-error Reassign
    multiSet = decorateWithMetrics(multiSet, 'Onyx.multiSet');
    // @ts-expect-error Reassign
    merge = decorateWithMetrics(merge, 'Onyx.merge');
    // @ts-expect-error Reassign
    mergeCollection = decorateWithMetrics(mergeCollection, 'Onyx.mergeCollection');
    // @ts-expect-error Reassign
    update = decorateWithMetrics(update, 'Onyx.update');
    // @ts-expect-error Reassign
    clear = decorateWithMetrics(clear, 'Onyx.clear');
    /* eslint-enable rulesdir/prefer-actions-set-data */
}

export default Onyx;
export type {OnyxUpdate, Mapping, ConnectOptions};
