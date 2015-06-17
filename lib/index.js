'use strict';
/* jshint -W003, -W079 */
var Promise = require('bluebird');
var _ = require('lodash');
var limiter = require('limiter');

Promise.promisifyAll(limiter.TokenBucket.prototype);

function AjaxLimited(options) {
  this.childBuckets = {};
  this.targets = [];
  if(options) {
    this.options = options;
    this.bucket = new limiter.TokenBucket(
      options.bucketSize,
      options.tokensPerInterval,
      options.interval
    );
  }
}

/**
 * Configures rate limitting into an object.
 *
 * @param {Object} target
 * @param {Object} [options]
 */

AjaxLimited.prototype.configure = function(target, options) {
  required(target, 'target');
  this.targets.push(target);

  if(options) {
    this.options = options;
    this.bucket = new limiter.TokenBucket(
      options.bucketSize,
      options.tokensPerInterval,
      options.interval
    );
  }

  this.injectInto(target);
};

/**
 * Restores the original ajax method on the configured targets or a target
 * object.
 *
 * @param {Object} [target]
 * @return {Function} originalAjax
 */

AjaxLimited.prototype.restore = function(target) {
  if(target) {
    target.ajax = this.originalAjax;
    return this.originalAjax;
  }

  _.each(this.targets, function(target) {
    target.ajax = this.originalAjax;
  }, this);

  return this.originalAjax;
};

/**
 * Finds and returns the appropriate bucket for a set of `ajax` parameters.
 *
 * @param {Array|Object} args
 * @return {TokenBucket}
 */

AjaxLimited.prototype.getBucketFor = function(args) {
  var url = args[0];
  var settings = args[1];
  if(typeof url !== 'string') {
    settings = url;
    url = settings.url;
  }

  if(!settings) {
    settings = {};
  }

  var method = (settings.method && settings.method.toLowerCase()) ||
               (settings.type && settings.type.toLowerCase()) ||
               'get';

  return this.childBuckets[method] || this.bucket;
};

/**
 * Injects the limited `ajax` method into a `target`. Suitable `target` values
 * are `Backbone` and `jQuery`.
 *
 * @param {Object} target
 * @param {Function} target.ajax
 */

AjaxLimited.prototype.injectInto = function(target) {
  this.originalAjax = target.ajax;
  var _this = this;
  this.ajax = target.ajax = function() {
    var args = arguments;
    var bucket = _this.getBucketFor(args);
    return bucket.removeTokensAsync(1).then(function() {
      return _this.originalAjax.apply(_this, args);
    });
  };
};

/**
 * Register a new bucket to handle `method` requests, defaulting to the root
 * bucket's options. Uses nesting to prevent from going over the shared limit.
 *
 * @param {String} method
 * @param {Object} options Same as options passed to
 *   `AjaxLimited.prototype.configure`
 * @return {TokenBucket} bucket The updated or created bucket
 */

AjaxLimited.prototype.registerBucket = function(method, options) {
  var bucket;

  if(method === 'all') {
    bucket = this.bucket;
  } else if(this.childBuckets[method]) {
    bucket = this.childBuckets[method];
  } else {
    // Create bucket if missing
    this.childBuckets[method] = new limiter.TokenBucket(
      options.bucketSize || this.bucket.bucketSize,
      options.tokensPerInterval || this.bucket.tokensPerInterval,
      options.interval || this.bucket.interval,
      this.bucket
    );
    return this.childBuckets[method];
  }

  // Update existing bucket
  bucket.bucketSize = options.bucketSize || this.bucket.bucketSize;
  bucket.tokensPerInterval = options.tokensPerInterval || this.bucket.tokensPerInterval;
  bucket.interval = options.interval || this.bucket.interval;
  return bucket;
};

_.each(['get', 'put', 'patch', 'post', 'delete', 'all'], function(method) {
  AjaxLimited.prototype[method] = function(options) {
    return this.registerBucket(method, options);
  };
});

/**
 * Receives initial options for each HTTP method (or all of them), modifies
 * buckets so they start with them and slowly transitions rate limitting until
 * the original rates are reached.
 *
 * @param {Object} options
 *
 * @example
 *   ajaxLimited.slowStart({
 *     get: {
 *       bucketSize: 9,
 *       tokensPerInterval: 9
 *     },
 *     'put,patch,post,delete': {
 *       bucketSize: 9,
 *       tokensPerInterval: 0,
 *     },
 *     interval: 9000
 *   });
 */

AjaxLimited.prototype.slowStart = function(options) {
  this.previousChildBuckets = this.childBuckets;

  this.childBuckets = {};
  _.each(['get', 'put', 'patch', 'post', 'delete', 'all'], function(method) {
    if(options[method]) {
      this.registerBucket(method, options[method]);
    } else if(this.previousChildBuckets[method]) {
      this.childBuckets[method] = this.previousChildBuckets[method];
    }
  }, this);

  if(options.all) {
    this._oldBucket = this.bucket;
    this.bucket = new limiter.TokenBucket();
    this.registerBucket('all', options.all);
  }

  _.each(options, function(value, key) {
    if(!_.contains(key, ',')) {
      return;
    }

    var methods = key.split(',');
    _.each(methods, function(method) {
      this.registerBucket(method, options[key]);
    }, this);
  }, this);

  var interval = options.interval || 5 * this.bucket.interval;
  var steps = this.getBucketSteps(interval);

  return this.slowStartStep(interval, steps);
};

/**
 * Steps through the slow start process every `interval` milliseconds. Applies
 * `steps` to each of the corresponding routes on each scheduled call and stops
 * when done. Returns a promise to the end of the process.
 *
 * @param {Number} interval
 * @param {Array} steps
 * @param {Number} steps[i].bucketSize
 * @param {Number} steps[i].tokensPerInterval
 * @return {Promise}
 */

AjaxLimited.prototype.slowStartStep = function(interval, steps) {
  var _this = this;
  return Promise.delay(interval).then(function() {
    // Step
    _.each(steps, _this.applyBucketStep, _this);

    // Recurse unless done
    if(!_this.isSlowStartDone()) {
      return _this.slowStartStep();
    }

    // Restore initial state
    if(_this.previousBucket) {
      _this.registerBucket('all', _this.previousBucket);
      delete _this.previousBucket;
    }

    if(_this.previousChildBuckets) {
      _.each(_this.previousChildBuckets, function(bucket, method) {
        _this.registerBucket(method, bucket);
      });
    }
  });
};

/**
 * Applies a `step` to the `method` bucket. If no `method` is provided, applies
 * it to the root bucket.
 *
 * @param {Object} step
 * @param {Number} step.tokensPerInterval
 * @param {Number} step.bucketSize
 * @param {String} method
 */

AjaxLimited.prototype.applyBucketStep = function(step, method) {
  var bucket = method === 'all' ? this.bucket : this.childBuckets[method];
  return this.registerBucket(method, {
    bucketSize: bucket.bucketSize + step.bucketSize,
    tokensPerInterval: bucket.tokensPerInterval + step.bucketSize,
  });
};

/**
 * Returns whether the slow start process has finished.
 *
 * @returns {Boolean}
 */

AjaxLimited.prototype.isSlowStartDone = function() {
  // Check if any method specific bucket is pending
  var childPending = _.any(this.childBuckets, function(slowBucket, method) {
    var fastBucket = this.previousChildBuckets[method] || this.bucket;
    return bucketIsFaster(slowBucket, fastBucket);
  }, this);

  if(childPending) {
    return false;
  }

  // Check if the root bucket is pending
  if(this.previousBucket) {
    return bucketIsFaster(this.bucket, this.previousBucket);
  }

  return true;
};

/**
 * Given slow start state has already been initialized, returns an object
 * representation of the bucket steps for child and root buckets.
 *
 * @param {Number} interval
 * @return {Object} steps
 */

AjaxLimited.prototype.getBucketSteps = function(interval) {
  var steps = _.mapValues(this.childBuckets, function(bucket, method) {
    this.getBucketStep(
      interval,
      this.previousChildBuckets[method] || this.bucket,
      bucket
    );
  }, this);

  steps.all = this.getBucketStep(interval, this.previousBucket, this.bucket);

  return steps;
};

/**
 * Returns the step for a certain bucket, given with which params it'll start,
 * where it should end and how long it should take.
 *
 * @param {Number} interval
 * @param {TokenBucket} start
 * @param {TokenBucket} end
 * @return {Object} step
 * @return {Number} step.tokensPerInterval
 * @return {Number} step.bucketSize
 */

AjaxLimited.prototype.getBucketStep = function(interval, start, end) {
  if(!start) {
    return {
      bucketSize: 0,
      tokensPerInterval: 0,
    };
  }

  var bucketSizeDelta = start.bucketSize - end.bucketSize;
  var tokensPerIntervalDelta = start.tokensPerInterval - end.tokensPerInterval;

  return {
    bucketSize: Math.max(bucketSizeDelta / interval, 1),
    tokensPerInterval: Math.max(tokensPerIntervalDelta / interval, 1),
  };
};

exports = module.exports = new AjaxLimited();
exports.AjaxLimited = AjaxLimited;

/**
 * Returns true if the first bucket parameter is "faster" than the second.
 *
 * @param {TokenBucket} b1
 * @param {TokenBucket} b2
 * @return {Boolean}
 */

function bucketIsFaster(b1, b2) {
  return b1.bucketSize >= b2.bucketSize ||
         b1.tokensPerInterval >= b2.tokensPerInterval;
}

/**
 * Throws an error if `p` doesn't exist
 *
 * @param {Mixed} p
 * @param {String} name
 */

function required(p, name) {
  if(p == null) {
    throwMissingParam(name);
  }
  return p;
}

function throwMissingParam(name) {
  throw new TypeError('Missing required param ' + name);
}
