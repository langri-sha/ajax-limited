'use strict';
/* jshint -W079 */
var Promise = require('bluebird');
var _ = require('lodash');
var limiter = require('limiter');

Promise.promisifyAll(limiter.TokenBucket.prototype);

function AjaxLimited() {
  this._routes = [];
}

AjaxLimited.prototype.configure = function($, options) {
  if(!options) {
    options = {};
  }

  this.$ = $;
  this._options = options;
  this.bucket = new limiter.TokenBucket(
    options.bucketSize,
    options.tokensPerInterval,
    options.interval
  );

  this._injectBucket($);
};

AjaxLimited.prototype.restore = function() {
  if(this.$) {
    this.$.ajax = this._originalAjax;
  }

  return this._originalAjax;
};

AjaxLimited.prototype._getBucketFor = function(args) {
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

  return this._routes[method] || this.bucket;
};

AjaxLimited.prototype._injectBucket = function($) {
  this._originalAjax = $.ajax;
  var _this = this;
  this.ajax = $.ajax = function() {
    var args = arguments;
    return new Promise(function(resolve, reject) {
      var bucket = _this._getBucketFor(args);
      bucket.removeTokens(1, function(err) {
        if(err) {
          reject(err);
          return;
        }

        resolve(_this._originalAjax.apply(_this, args));
      });
    }).catch(_this._handleAjaxError.bind(this));
  };
};

AjaxLimited.prototype._handleAjaxError = function(err) {
  throw err;
};

AjaxLimited.prototype._registerRoute = function(method, options) {
  var _this = this;
  var bucket;

  if(method === 'all') {
    bucket = this.bucket;
    ['get', 'post', 'put', 'patch', 'delete'].forEach(function(method) {
      if(_this._routes[method]) {
        _this._routes[method].bucket = bucket;
      }
    });
  } else if(this._routes[method]) {
    bucket = this._routes[method];
  } else {
    this._routes[method] = new limiter.TokenBucket(
      options.bucketSize || this.bucket.bucketSize,
      options.tokensPerInterval || this.bucket.tokensPerInterval,
      options.interval || this.bucket.interval,
      this.bucket
    );
    return this;
  }

  bucket.bucketSize = options.bucketSize || this.bucket.bucketSize;
  bucket.tokensPerInterval = options.tokensPerInterval || this.bucket.tokensPerInterval;
  bucket.interval = options.interval || this.bucket.interval;
  return this;
};

['get', 'put', 'patch', 'post', 'delete', 'all'].forEach(function(method) {
  AjaxLimited.prototype[method] = function(options) {
    return this._registerRoute(method, options);
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
  this._oldRoutes = this._routes;
  var _this = this;

  this._routes = {};
  ['get', 'put', 'patch', 'post', 'delete', 'all'].forEach(function(method) {
    if(options[method]) {
      _this._registerRoute(method, options[method]);
    } else if(_this._oldRoutes[method]) {
      _this._routes[method] = _this._oldRoutes[method];
    }
  });

  if(options.all) {
    this._oldBucket = this.bucket;
    this.bucket = new limiter.TokenBucket();
    this._registerRoute('all', options.all);
  }

  _.each(options, function(value, key) {
    if(!_.contains(key, ',')) {
      return;
    }

    var methods = key.split(',');
    _.each(methods, function(method) {
      _this._registerRoute(method, options[key]);
    });
  });

  var interval = options.interval || 5 * this.bucket.interval;

  var steps = _.mapValues(this._routes, function(route, method) {
    return exports._getBucketStep(
      interval,
      _this._oldRoutes[method] || _this.bucket,
      route
    );
  });
  steps.all = exports._getBucketStep(interval, this._oldBucket, this.bucket);

  this._slowStartStep(interval, steps);
};

AjaxLimited.prototype._slowStartStep = function(interval, steps) {
  var _this = this;
  setTimeout(function() {
    // Step
    _.each(steps, function(step, key) {
      var bucket = key === 'all' ? _this.bucket : _this._routes[key];
      _this._registerRoute(key, {
        bucketSize: bucket.bucketSize + step.bucketSize,
        tokensPerInterval: bucket.tokensPerInterval + step.tokensPerInterval,
      });
    });

    if(!_this.isSlowStartDone()) {
      _this._slowStartStep(interval, steps);
      return;
    }

    // Restore when done

    if(_this.oldBucket) {
      _this._registerRoute('all', _this._oldBucket);
    }

    _this.routes = {};
    if(_this._oldRoutes) {
      _.each(_this._oldRoutes, function(route, method) {
        _this._registerRoute(method, route);
      });
    }
  }, interval);
};

AjaxLimited.prototype.isSlowStartDone = function() {
  var _this = this;
  var methodRoutePending = _.any(this._routes, function(route, method) {
    var oldRoute = _this._oldRoutes[method] || _this.bucket;
    return oldRoute.bucketSize > route.bucketSize ||
           oldRoute.tokensPerInterval > route.tokensPerInterval;
  });

  if(methodRoutePending) {
    return false;
  }

  if(this._oldBucket) {
    return this._oldBucket.bucketSize <= this.bucket.bucketSize &&
           this._oldBucket.tokensPerInterval <= this.bucket.tokensPerInterval;
  }

  return true;
};

exports = module.exports = new AjaxLimited();
exports.AjaxLimited = AjaxLimited;

exports._getBucketStep = function getBucketStep(interval, start, end) {
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
