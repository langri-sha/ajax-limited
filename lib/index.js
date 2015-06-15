'use strict';
/* jshint -W079 */
var Backbone = require('backbone');
var Promise = require('bluebird');
var limiter = require('limiter');

Promise.promisifyAll(limiter.TokenBucket.prototype);

function AjaxLimited() {
  this._routes = [];
}

Object.keys(Backbone.Events).forEach(function(key) {
  AjaxLimited.prototype[key] = Backbone.Events[key];
});

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

  if(options.slowStart) {
    var _this = this;
    this.one('online', function() {
      _this._slowStartBucket();
    });
  }

  this._injectBucket($);
};

AjaxLimited.prototype.restore = function() {
  if(Backbone.ajax) {
    Backbone.ajax = this._originalAjax;
  }

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

  for(var i = 0, len = this._routes.length; i < len; i++) {
    var route = this._routes[i];
    if(route.method) {
      var method = (settings.method && settings.method.toLowerCase()) ||
                   (settings.type && settings.type.toLowerCase()) ||
                   'get';
      if(route.method !== false && route.method !== method) {
        continue;
      }
    }

    if(route.pattern.test(url)) {
      return route.bucket;
    }
  }

  return this.bucket;
};

AjaxLimited.prototype._injectBucket = function($) {
  this._originalAjax = $.ajax;
  var _this = this;
  this.ajax = Backbone.ajax = $.ajax = function() {
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
    });
  };
};

AjaxLimited.prototype._slowStartBucket = function() {
};

AjaxLimited.prototype._registerRoute = function(method, pattern, options) {
  if(!options) {
    options = pattern || {};
    pattern = '.*';
  }

  if(typeof pattern === 'string') {
    pattern = new RegExp(pattern);
  }

  this._routes.push({
    method: method,
    pattern: pattern,
    bucket: new limiter.TokenBucket(
      options.bucketSize || this._options.bucketSize,
      options.tokensPerInterval || this._options.tokensPerInterval,
      options.interval || this._options.interval,
      this.bucket
    ),
  });

  return this;
};

['get', 'put', 'patch', 'post', 'delete'].forEach(function(method) {
  AjaxLimited.prototype[method] = function(pattern, options) {
    return this._registerRoute(method, pattern, options);
  };
});

AjaxLimited.prototype.all = function(pattern, options) {
  return this._registerRoute(false, pattern, options);
};

exports = module.exports = new AjaxLimited();
exports.AjaxLimited = AjaxLimited;
