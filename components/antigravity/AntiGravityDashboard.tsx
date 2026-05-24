import React, { useState } from 'react';
import Layout from './Layout';
import Sidebar from './Sidebar';
import Header from './Header';
import BentoStats from './BentoStats';
import ApprovalList from './ApprovalList';
import RequestManagement from './RequestManagement';
import Schedule from './Schedule';
import Messenger from './Messenger';

const AntiGravityDashboard: React.FC = () => {
    const [activePage, setActivePage] = useState('dashboard');

    return (
        <Layout
            sidebar={<Sidebar activePage={activePage} setActivePage={setActivePage} />}
            messenger={<Messenger />}
        >
            <div className="animate-load">
                <Header 
                    userName="Administrator" 
                    date="Tuesday, March 15, 2024" 
                />

                <div className="grid grid-cols-12 gap-8">
                    {/* Left & Middle Column (Main Content) */}
                    <div className="col-span-12 xl:col-span-8 space-y-8">
                        <BentoStats />
                        
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                            <ApprovalList />
                            <RequestManagement />
                        </div>
                    </div>

                    {/* Right Column (Sidebar within main) */}
                    <div className="col-span-12 xl:col-span-4">
                        <Schedule />
                    </div>
                </div>
            </div>
        </Layout>
    );
};

export default AntiGravityDashboard;
