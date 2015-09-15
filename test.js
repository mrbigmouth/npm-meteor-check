describe('check', function () {
  'use strict';

  var assume = require('assume')
    , check = require('./').check;

  it('is working', function () {

    assume(function() {
    	check(5, Boolean);
    }).to.throw('Match error: Expected boolean, got number');

  });
});

describe('Match', function () {
  'use strict';

  var assume = require('assume')
    , Match = require('./').Match;

  it('is working', function () {

    assume(Match.test({}, Object)).to.equal(true);

    assume(Match.test({
    	name: 'foo',
    	age: 12,
    	child: true
    }, {
    	name: String,
    	age: Number,
    	child: Boolean
    })).to.equal(true);

  });
});
