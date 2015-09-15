module.exports = (function () {
"use strict";
var Meteor = { isServer: true, _noYieldsAllowed:function nope(f) { return f(); }};
var Npm = { require: require };
var check, Match;
var _ = require("underscore");
var EJSON = require("ejson");
if (Meteor.isServer)
  var Future = Npm.require('fibers/future');

if (typeof __meteor_runtime_config__ === 'object' &&
    __meteor_runtime_config__.meteorRelease) {
  /**
   * @summary `Meteor.release` is a string containing the name of the [release](#meteorupdate) with which the project was built (for example, `"1.2.3"`). It is `undefined` if the project was built using a git checkout of Meteor.
   * @locus Anywhere
   * @type {String}
   */
  Meteor.release = __meteor_runtime_config__.meteorRelease;
}

// XXX find a better home for these? Ideally they would be _.get,
// _.ensure, _.delete..

_.extend(Meteor, {
  // _get(a,b,c,d) returns a[b][c][d], or else undefined if a[b] or
  // a[b][c] doesn't exist.
  //
  _get: function (obj /*, arguments */) {
    for (var i = 1; i < arguments.length; i++) {
      if (!(arguments[i] in obj))
        return undefined;
      obj = obj[arguments[i]];
    }
    return obj;
  },

  // _ensure(a,b,c,d) ensures that a[b][c][d] exists. If it does not,
  // it is created and set to {}. Either way, it is returned.
  //
  _ensure: function (obj /*, arguments */) {
    for (var i = 1; i < arguments.length; i++) {
      var key = arguments[i];
      if (!(key in obj))
        obj[key] = {};
      obj = obj[key];
    }

    return obj;
  },

  // _delete(a, b, c, d) deletes a[b][c][d], then a[b][c] unless it
  // isn't empty, then a[b] unless it isn't empty.
  //
  _delete: function (obj /*, arguments */) {
    var stack = [obj];
    var leaf = true;
    for (var i = 1; i < arguments.length - 1; i++) {
      var key = arguments[i];
      if (!(key in obj)) {
        leaf = false;
        break;
      }
      obj = obj[key];
      if (typeof obj !== "object")
        break;
      stack.push(obj);
    }

    for (var i = stack.length - 1; i >= 0; i--) {
      var key = arguments[i+1];

      if (leaf)
        leaf = false;
      else
        for (var other in stack[i][key])
          return; // not empty -- we're done

      delete stack[i][key];
    }
  },

  // wrapAsync can wrap any function that takes some number of arguments that
  // can't be undefined, followed by some optional arguments, where the callback
  // is the last optional argument.
  // e.g. fs.readFile(pathname, [callback]),
  // fs.open(pathname, flags, [mode], [callback])
  // For maximum effectiveness and least confusion, wrapAsync should be used on
  // functions where the callback is the only argument of type Function.

  /**
   * @memberOf Meteor
   * @summary Wrap a function that takes a callback function as its final parameter. The signature of the callback of the wrapped function should be `function(error, result){}`. On the server, the wrapped function can be used either synchronously (without passing a callback) or asynchronously (when a callback is passed). On the client, a callback is always required; errors will be logged if there is no callback. If a callback is provided, the environment captured when the original function was called will be restored in the callback.
   * @locus Anywhere
   * @param {Function} func A function that takes a callback as its final parameter
   * @param {Object} [context] Optional `this` object against which the original function will be invoked
   */
  wrapAsync: function (fn, context) {
    return function (/* arguments */) {
      var self = context || this;
      var newArgs = _.toArray(arguments);
      var callback;

      for (var i = newArgs.length - 1; i >= 0; --i) {
        var arg = newArgs[i];
        var type = typeof arg;
        if (type !== "undefined") {
          if (type === "function") {
            callback = arg;
          }
          break;
        }
      }

      if (! callback) {
        if (Meteor.isClient) {
          callback = logErr;
        } else {
          var fut = new Future();
          callback = fut.resolver();
        }
        ++i; // Insert the callback just after arg.
      }

      newArgs[i] = Meteor.bindEnvironment(callback);
      var result = fn.apply(self, newArgs);
      return fut ? fut.wait() : result;
    };
  },

  // Sets child's prototype to a new object whose prototype is parent's
  // prototype. Used as:
  //   Meteor._inherits(ClassB, ClassA).
  //   _.extend(ClassB.prototype, { ... })
  // Inspired by CoffeeScript's `extend` and Google Closure's `goog.inherits`.
  _inherits: function (Child, Parent) {
    // copy Parent static properties
    for (var key in Parent) {
      // make sure we only copy hasOwnProperty properties vs. prototype
      // properties
      if (_.has(Parent, key))
        Child[key] = Parent[key];
    }

    // a middle member of prototype chain: takes the prototype from the Parent
    var Middle = function () {
      this.constructor = Child;
    };
    Middle.prototype = Parent.prototype;
    Child.prototype = new Middle();
    Child.__super__ = Parent.prototype;
    return Child;
  }
});

var warnedAboutWrapAsync = false;

/**
 * @deprecated in 0.9.3
 */
Meteor._wrapAsync = function(fn, context) {
  if (! warnedAboutWrapAsync) {
    Meteor._debug("Meteor._wrapAsync has been renamed to Meteor.wrapAsync");
    warnedAboutWrapAsync = true;
  }
  return Meteor.wrapAsync.apply(Meteor, arguments);
};

function logErr(err) {
  if (err) {
    return Meteor._debug(
      "Exception in callback of async function",
      err.stack ? err.stack : err
    );
  }
}

// Makes an error subclass which properly contains a stack trace in most
// environments. constructor can set fields on `this` (and should probably set
// `message`, which is what gets displayed at the top of a stack trace).
//
Meteor.makeErrorType = function (name, constructor) {
  var errorClass = function (/*arguments*/) {
    var self = this;

    // Ensure we get a proper stack trace in most Javascript environments
    if (Error.captureStackTrace) {
      // V8 environments (Chrome and Node.js)
      Error.captureStackTrace(self, errorClass);
    } else {
      // Firefox
      var e = new Error;
      e.__proto__ = errorClass.prototype;
      if (e instanceof errorClass)
        self = e;
    }
    // Safari magically works.

    constructor.apply(self, arguments);

    self.errorType = name;

    return self;
  };

  Meteor._inherits(errorClass, Error);

  return errorClass;
};

// This should probably be in the livedata package, but we don't want
// to require you to use the livedata package to get it. Eventually we
// should probably rename it to DDP.Error and put it back in the
// 'livedata' package (which we should rename to 'ddp' also.)
//
// Note: The DDP server assumes that Meteor.Error EJSON-serializes as an object
// containing 'error' and optionally 'reason' and 'details'.
// The DDP client manually puts these into Meteor.Error objects. (We don't use
// EJSON.addType here because the type is determined by location in the
// protocol, not text on the wire.)

/**
 * @summary This class represents a symbolic error thrown by a method.
 * @locus Anywhere
 * @class
 * @param {String} error A string code uniquely identifying this kind of error.
 * This string should be used by callers of the method to determine the
 * appropriate action to take, instead of attempting to parse the reason
 * or details fields. For example:
 *
 * ```
 * // on the server, pick a code unique to this error
 * // the reason field should be a useful debug message
 * throw new Meteor.Error("logged-out", 
 *   "The user must be logged in to post a comment.");
 *
 * // on the client
 * Meteor.call("methodName", function (error) {
 *   // identify the error
 *   if (error && error.error === "logged-out") {
 *     // show a nice error message
 *     Session.set("errorMessage", "Please log in to post a comment.");
 *   }
 * });
 * ```
 * 
 * For legacy reasons, some built-in Meteor functions such as `check` throw
 * errors with a number in this field.
 * 
 * @param {String} [reason] Optional.  A short human-readable summary of the
 * error, like 'Not Found'.
 * @param {String} [details] Optional.  Additional information about the error,
 * like a textual stack trace.
 */
Meteor.Error = Meteor.makeErrorType(
  "Meteor.Error",
  function (error, reason, details) {
    var self = this;

    // String code uniquely identifying this kind of error.
    self.error = error;

    // Optional: A short human-readable summary of the error. Not
    // intended to be shown to end users, just developers. ("Not Found",
    // "Internal Server Error")
    self.reason = reason;

    // Optional: Additional information about the error, say for
    // debugging. It might be a (textual) stack trace if the server is
    // willing to provide one. The corresponding thing in HTTP would be
    // the body of a 404 or 500 response. (The difference is that we
    // never expect this to be shown to end users, only developers, so
    // it doesn't need to be pretty.)
    self.details = details;

    // This is what gets displayed at the top of a stack trace. Current
    // format is "[404]" (if no reason is set) or "File not found [404]"
    if (self.reason)
      self.message = self.reason + ' [' + self.error + ']';
    else
      self.message = '[' + self.error + ']';
  });

// Meteor.Error is basically data and is sent over DDP, so you should be able to
// properly EJSON-clone it. This is especially important because if a
// Meteor.Error is thrown through a Future, the error, reason, and details
// properties become non-enumerable so a standard Object clone won't preserve
// them and they will be lost from DDP.
Meteor.Error.prototype.clone = function () {
  var self = this;
  return new Meteor.Error(self.error, self.reason, self.details);
};

// Fiber-aware implementation of dynamic scoping, for use on the server

var Fiber = Npm.require('fibers');

var nextSlot = 0;

Meteor._nodeCodeMustBeInFiber = function () {
  if (!Fiber.current) {
    throw new Error("Meteor code must always run within a Fiber. " +
                    "Try wrapping callbacks that you pass to non-Meteor " +
                    "libraries with Meteor.bindEnvironment.");
  }
};

Meteor.EnvironmentVariable = function () {
  this.slot = nextSlot++;
};

_.extend(Meteor.EnvironmentVariable.prototype, {
  get: function () {
    Meteor._nodeCodeMustBeInFiber();

    return Fiber.current._meteor_dynamics &&
      Fiber.current._meteor_dynamics[this.slot];
  },

  // Most Meteor code ought to run inside a fiber, and the
  // _nodeCodeMustBeInFiber assertion helps you remember to include appropriate
  // bindEnvironment calls (which will get you the *right value* for your
  // environment variables, on the server).
  //
  // In some very special cases, it's more important to run Meteor code on the
  // server in non-Fiber contexts rather than to strongly enforce the safeguard
  // against forgetting to use bindEnvironment. For example, using `check` in
  // some top-level constructs like connect handlers without needing unnecessary
  // Fibers on every request is more important that possibly failing to find the
  // correct argumentChecker. So this function is just like get(), but it
  // returns null rather than throwing when called from outside a Fiber. (On the
  // client, it is identical to get().)
  getOrNullIfOutsideFiber: function () {
    if (!Fiber.current)
      return null;
    return this.get();
  },

  withValue: function (value, func) {
    Meteor._nodeCodeMustBeInFiber();

    if (!Fiber.current._meteor_dynamics)
      Fiber.current._meteor_dynamics = [];
    var currentValues = Fiber.current._meteor_dynamics;

    var saved = currentValues[this.slot];
    try {
      currentValues[this.slot] = value;
      var ret = func();
    } finally {
      currentValues[this.slot] = saved;
    }

    return ret;
  }
});

// Meteor application code is always supposed to be run inside a
// fiber. bindEnvironment ensures that the function it wraps is run from
// inside a fiber and ensures it sees the values of Meteor environment
// variables that are set at the time bindEnvironment is called.
//
// If an environment-bound function is called from outside a fiber (eg, from
// an asynchronous callback from a non-Meteor library such as MongoDB), it'll
// kick off a new fiber to execute the function, and returns undefined as soon
// as that fiber returns or yields (and func's return value is ignored).
//
// If it's called inside a fiber, it works normally (the
// return value of the function will be passed through, and no new
// fiber will be created.)
//
// `onException` should be a function or a string.  When it is a
// function, it is called as a callback when the bound function raises
// an exception.  If it is a string, it should be a description of the
// callback, and when an exception is raised a debug message will be
// printed with the description.
Meteor.bindEnvironment = function (func, onException, _this) {
  Meteor._nodeCodeMustBeInFiber();

  var boundValues = _.clone(Fiber.current._meteor_dynamics || []);

  if (!onException || typeof(onException) === 'string') {
    var description = onException || "callback of async function";
    onException = function (error) {
      Meteor._debug(
        "Exception in " + description + ":",
        error && error.stack || error
      );
    };
  }

  return function (/* arguments */) {
    var args = _.toArray(arguments);

    var runWithEnvironment = function () {
      var savedValues = Fiber.current._meteor_dynamics;
      try {
        // Need to clone boundValues in case two fibers invoke this
        // function at the same time
        Fiber.current._meteor_dynamics = _.clone(boundValues);
        var ret = func.apply(_this, args);
      } catch (e) {
        // note: callback-hook currently relies on the fact that if onException
        // throws and you were originally calling the wrapped callback from
        // within a Fiber, the wrapped call throws.
        onException(e);
      } finally {
        Fiber.current._meteor_dynamics = savedValues;
      }
      return ret;
    };

    if (Fiber.current)
      return runWithEnvironment();
    Fiber(runWithEnvironment).run();
  };
};

// XXX docs

// Things we explicitly do NOT support:
//    - heterogenous arrays

var currentArgumentChecker = new Meteor.EnvironmentVariable;

/**
 * @summary Check that a value matches a [pattern](#matchpatterns).
 * If the value does not match the pattern, throw a `Match.Error`.
 *
 * Particularly useful to assert that arguments to a function have the right
 * types and structure.
 * @locus Anywhere
 * @param {Any} value The value to check
 * @param {MatchPattern} pattern The pattern to match
 * `value` against
 */
check = function (value, pattern) {
  // Record that check got called, if somebody cared.
  //
  // We use getOrNullIfOutsideFiber so that it's OK to call check()
  // from non-Fiber server contexts; the downside is that if you forget to
  // bindEnvironment on some random callback in your method/publisher,
  // it might not find the argumentChecker and you'll get an error about
  // not checking an argument that it looks like you're checking (instead
  // of just getting a "Node code must run in a Fiber" error).
  var argChecker = currentArgumentChecker.getOrNullIfOutsideFiber();
  if (argChecker)
    argChecker.checking(value);
  try {
    checkSubtree(value, pattern);
  } catch (err) {
    if ((err instanceof Match.Error) && err.path)
      err.message += " in field " + err.path;
    throw err;
  }
};

/**
 * @namespace Match
 * @summary The namespace for all Match types and methods.
 */
Match = {
  Optional: function (pattern) {
    return new Optional(pattern);
  },
  OneOf: function (/*arguments*/) {
    return new OneOf(_.toArray(arguments));
  },
  Any: ['__any__'],
  Where: function (condition) {
    return new Where(condition);
  },
  ObjectIncluding: function (pattern) {
    return new ObjectIncluding(pattern);
  },
  ObjectWithValues: function (pattern) {
    return new ObjectWithValues(pattern);
  },
  // Matches only signed 32-bit integers
  Integer: ['__integer__'],

  // XXX matchers should know how to describe themselves for errors
  Error: Meteor.makeErrorType("Match.Error", function (msg) {
    this.message = "Match error: " + msg;
    // The path of the value that failed to match. Initially empty, this gets
    // populated by catching and rethrowing the exception as it goes back up the
    // stack.
    // E.g.: "vals[3].entity.created"
    this.path = "";
    // If this gets sent over DDP, don't give full internal details but at least
    // provide something better than 500 Internal server error.
    this.sanitizedError = new Meteor.Error(400, "Match failed");
  }),

  // Tests to see if value matches pattern. Unlike check, it merely returns true
  // or false (unless an error other than Match.Error was thrown). It does not
  // interact with _failIfArgumentsAreNotAllChecked.
  // XXX maybe also implement a Match.match which returns more information about
  //     failures but without using exception handling or doing what check()
  //     does with _failIfArgumentsAreNotAllChecked and Meteor.Error conversion

  /**
   * @summary Returns true if the value matches the pattern.
   * @locus Anywhere
   * @param {Any} value The value to check
   * @param {MatchPattern} pattern The pattern to match `value` against
   */
  test: function (value, pattern) {
    try {
      checkSubtree(value, pattern);
      return true;
    } catch (e) {
      if (e instanceof Match.Error)
        return false;
      // Rethrow other errors.
      throw e;
    }
  },

  // Runs `f.apply(context, args)`. If check() is not called on every element of
  // `args` (either directly or in the first level of an array), throws an error
  // (using `description` in the message).
  //
  _failIfArgumentsAreNotAllChecked: function (f, context, args, description) {
    var argChecker = new ArgumentChecker(args, description);
    var result = currentArgumentChecker.withValue(argChecker, function () {
      return f.apply(context, args);
    });
    // If f didn't itself throw, make sure it checked all of its arguments.
    argChecker.throwUnlessAllArgumentsHaveBeenChecked();
    return result;
  }
};

var Optional = function (pattern) {
  this.pattern = pattern;
};

var OneOf = function (choices) {
  if (_.isEmpty(choices))
    throw new Error("Must provide at least one choice to Match.OneOf");
  this.choices = choices;
};

var Where = function (condition) {
  this.condition = condition;
};

var ObjectIncluding = function (pattern) {
  this.pattern = pattern;
};

var ObjectWithValues = function (pattern) {
  this.pattern = pattern;
};

var typeofChecks = [
  [String, "string"],
  [Number, "number"],
  [Boolean, "boolean"],
  // While we don't allow undefined in EJSON, this is good for optional
  // arguments with OneOf.
  [undefined, "undefined"]
];

var checkSubtree = function (value, pattern) {
  // Match anything!
  if (pattern === Match.Any)
    return;

  // Basic atomic types.
  // Do not match boxed objects (e.g. String, Boolean)
  for (var i = 0; i < typeofChecks.length; ++i) {
    if (pattern === typeofChecks[i][0]) {
      if (typeof value === typeofChecks[i][1])
        return;
      throw new Match.Error("Expected " + typeofChecks[i][1] + ", got " +
                            typeof value);
    }
  }
  if (pattern === null) {
    if (value === null)
      return;
    throw new Match.Error("Expected null, got " + EJSON.stringify(value));
  }

  // Strings, numbers, and booleans match literally. Goes well with Match.OneOf.
  if (typeof pattern === "string" || typeof pattern === "number" || typeof pattern === "boolean") {
    if (value === pattern)
      return;
    throw new Match.Error("Expected " + pattern + ", got " +
                          EJSON.stringify(value));
  }

  // Match.Integer is special type encoded with array
  if (pattern === Match.Integer) {
    // There is no consistent and reliable way to check if variable is a 64-bit
    // integer. One of the popular solutions is to get reminder of division by 1
    // but this method fails on really large floats with big precision.
    // E.g.: 1.348192308491824e+23 % 1 === 0 in V8
    // Bitwise operators work consistantly but always cast variable to 32-bit
    // signed integer according to JavaScript specs.
    if (typeof value === "number" && (value | 0) === value)
      return
    throw new Match.Error("Expected Integer, got "
                + (value instanceof Object ? EJSON.stringify(value) : value));
  }

  // "Object" is shorthand for Match.ObjectIncluding({});
  if (pattern === Object)
    pattern = Match.ObjectIncluding({});

  // Array (checked AFTER Any, which is implemented as an Array).
  if (pattern instanceof Array) {
    if (pattern.length !== 1)
      throw Error("Bad pattern: arrays must have one type element" +
                  EJSON.stringify(pattern));
    if (!_.isArray(value) && !_.isArguments(value)) {
      throw new Match.Error("Expected array, got " + EJSON.stringify(value));
    }

    _.each(value, function (valueElement, index) {
      try {
        checkSubtree(valueElement, pattern[0]);
      } catch (err) {
        if (err instanceof Match.Error) {
          err.path = _prependPath(index, err.path);
        }
        throw err;
      }
    });
    return;
  }

  // Arbitrary validation checks. The condition can return false or throw a
  // Match.Error (ie, it can internally use check()) to fail.
  if (pattern instanceof Where) {
    if (pattern.condition(value))
      return;
    // XXX this error is terrible
    throw new Match.Error("Failed Match.Where validation");
  }


  if (pattern instanceof Optional)
    pattern = Match.OneOf(undefined, pattern.pattern);

  if (pattern instanceof OneOf) {
    for (var i = 0; i < pattern.choices.length; ++i) {
      try {
        checkSubtree(value, pattern.choices[i]);
        // No error? Yay, return.
        return;
      } catch (err) {
        // Other errors should be thrown. Match errors just mean try another
        // choice.
        if (!(err instanceof Match.Error))
          throw err;
      }
    }
    // XXX this error is terrible
    throw new Match.Error("Failed Match.OneOf or Match.Optional validation");
  }

  // A function that isn't something we special-case is assumed to be a
  // constructor.
  if (pattern instanceof Function) {
    if (value instanceof pattern)
      return;
    throw new Match.Error("Expected " + (pattern.name ||
                                         "particular constructor"));
  }

  var unknownKeysAllowed = false;
  var unknownKeyPattern;
  if (pattern instanceof ObjectIncluding) {
    unknownKeysAllowed = true;
    pattern = pattern.pattern;
  }
  if (pattern instanceof ObjectWithValues) {
    unknownKeysAllowed = true;
    unknownKeyPattern = [pattern.pattern];
    pattern = {};  // no required keys
  }

  if (typeof pattern !== "object")
    throw Error("Bad pattern: unknown pattern type");

  // An object, with required and optional keys. Note that this does NOT do
  // structural matches against objects of special types that happen to match
  // the pattern: this really needs to be a plain old {Object}!
  if (typeof value !== 'object')
    throw new Match.Error("Expected object, got " + typeof value);
  if (value === null)
    throw new Match.Error("Expected object, got null");
  if (value.constructor !== Object)
    throw new Match.Error("Expected plain object");

  var requiredPatterns = {};
  var optionalPatterns = {};
  _.each(pattern, function (subPattern, key) {
    if (subPattern instanceof Optional)
      optionalPatterns[key] = subPattern.pattern;
    else
      requiredPatterns[key] = subPattern;
  });

  _.each(value, function (subValue, key) {
    try {
      if (_.has(requiredPatterns, key)) {
        checkSubtree(subValue, requiredPatterns[key]);
        delete requiredPatterns[key];
      } else if (_.has(optionalPatterns, key)) {
        checkSubtree(subValue, optionalPatterns[key]);
      } else {
        if (!unknownKeysAllowed)
          throw new Match.Error("Unknown key");
        if (unknownKeyPattern) {
          checkSubtree(subValue, unknownKeyPattern[0]);
        }
      }
    } catch (err) {
      if (err instanceof Match.Error)
        err.path = _prependPath(key, err.path);
      throw err;
    }
  });

  _.each(requiredPatterns, function (subPattern, key) {
    throw new Match.Error("Missing key '" + key + "'");
  });
};

var ArgumentChecker = function (args, description) {
  var self = this;
  // Make a SHALLOW copy of the arguments. (We'll be doing identity checks
  // against its contents.)
  self.args = _.clone(args);
  // Since the common case will be to check arguments in order, and we splice
  // out arguments when we check them, make it so we splice out from the end
  // rather than the beginning.
  self.args.reverse();
  self.description = description;
};

_.extend(ArgumentChecker.prototype, {
  checking: function (value) {
    var self = this;
    if (self._checkingOneValue(value))
      return;
    // Allow check(arguments, [String]) or check(arguments.slice(1), [String])
    // or check([foo, bar], [String]) to count... but only if value wasn't
    // itself an argument.
    if (_.isArray(value) || _.isArguments(value)) {
      _.each(value, _.bind(self._checkingOneValue, self));
    }
  },
  _checkingOneValue: function (value) {
    var self = this;
    for (var i = 0; i < self.args.length; ++i) {
      // Is this value one of the arguments? (This can have a false positive if
      // the argument is an interned primitive, but it's still a good enough
      // check.)
      // (NaN is not === to itself, so we have to check specially.)
      if (value === self.args[i] || (_.isNaN(value) && _.isNaN(self.args[i]))) {
        self.args.splice(i, 1);
        return true;
      }
    }
    return false;
  },
  throwUnlessAllArgumentsHaveBeenChecked: function () {
    var self = this;
    if (!_.isEmpty(self.args))
      throw new Error("Did not check() all arguments during " +
                      self.description);
  }
});

var _jsKeywords = ["do", "if", "in", "for", "let", "new", "try", "var", "case",
  "else", "enum", "eval", "false", "null", "this", "true", "void", "with",
  "break", "catch", "class", "const", "super", "throw", "while", "yield",
  "delete", "export", "import", "public", "return", "static", "switch",
  "typeof", "default", "extends", "finally", "package", "private", "continue",
  "debugger", "function", "arguments", "interface", "protected", "implements",
  "instanceof"];

// Assumes the base of path is already escaped properly
// returns key + base
var _prependPath = function (key, base) {
  if ((typeof key) === "number" || key.match(/^[0-9]+$/))
    key = "[" + key + "]";
  else if (!key.match(/^[a-z_$][0-9a-z_$]*$/i) || _.contains(_jsKeywords, key))
    key = JSON.stringify([key]);

  if (base && base[0] !== "[")
    return key + '.' + base;
  return key + base;
};


  return { check: check, Match: Match, Meteor: Meteor };
}).call(this);