import {useEffect} from 'react';
import {Redirect} from '@docusaurus/router';

export default function Home() {
  // Automatically redirect to the documentation
  return <Redirect to="/docs/" />;
}