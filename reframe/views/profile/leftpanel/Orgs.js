import React from 'react';

import './Orgs.css';
import Avatar from '../Avatar';

const Orgs = props => {
  const orgAvatar = org => (
    <a key={org} href={`https://github.com/${org}`} target="_blank" title={org}>
      <Avatar url={props.allOrgs[org].avatar_url} classes="avatar-org" />
    </a>
  );

  const memberOf = [];
  for (const org of props.userOrgs) {
    memberOf.push(orgAvatar(org));
  }
  const contributedTo = [];
  for (const org of props.contribOrgs) {
    contributedTo.push(orgAvatar(org));
  }

  if (!memberOf.length && !contributedTo.length) {
    return <div></div>;
  }

  const sections = [];
  let classes = 'mb-1';
  if (memberOf.length) {
    sections.push(<div key='memberOf'><h4 className={classes}>Member of</h4>{memberOf}</div>);
  }
  if (contributedTo.length) {
    if (memberOf.length) {
      classes = `mt-4 ${classes}`;
    }
    sections.push(
      <div key='contributedTo'><h4 className={classes}>Contributed to</h4>{contributedTo}</div>
    );
  }

  return (
    <div className="border-top border-gray-light py-3">{sections}</div>
  );
};

export default Orgs;
